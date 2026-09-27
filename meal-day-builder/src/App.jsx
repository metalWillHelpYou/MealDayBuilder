import { useState, useEffect, useRef } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { auth, db } from "./firebase";

/**
 * Конструктор дня — пользователь сам наполняет списки позиций
 * (базы, белки, гарниры и т.д.), а генератор свободно комбинирует
 * их между собой, не привязываясь к дню недели.
 *
 * Это самодостаточная версия: вся стилизация — обычный CSS в одном
 * встроенном <style> теге, без Tailwind и любых сторонних зависимостей.
 * Так исключены любые расхождения из-за отсутствия/иной настройки
 * Tailwind в проекте. Вкладки «День» и «Неделя» рендерятся в одну и
 * ту же ячейку сетки (наложением), поэтому контейнер всегда занимает
 * одинаковую высоту — под более высокую из двух вкладок — и переключение
 * между ними никогда не меняет размеры страницы.
 */

const INK = "#2B2A26";
const PAPER = "#F1EBDD";
const LINE = "#D9D0BC";
const MUTED = "#5C5850";
const PAGE_BG = "#EDE6D6";
const SANS = "'IBM Plex Sans', system-ui, sans-serif";
const SERIF = "Fraunces, Georgia, serif";

const MEAL_META = {
  breakfast: { label: "Завтрак", accent: "#C9A227" },
  lunch: { label: "Обед", accent: "#A64B2A" },
  dinner: { label: "Ужин", accent: "#3A5A40" },
};

const SHARED_ACCENT = "#7A5C3E";

const DAY_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт"];

const EMPTY_DATA = {
  breakfast: { bases: [], addons: [] },
  lunch: { carbs: [] },
  dinner: { sides: [] },
  shared: { proteins: [] },
};

/* ---------------------------- генератор плана ---------------------------- */
/*
 * Вместо чистой случайности используется «колода» (shuffle bag) на каждую
 * категорию: все позиции перемешиваются один раз и раздаются по очереди,
 * колода не сдаётся заново, пока не закончится. Так гарантируется, что за
 * один цикл каждая позиция используется примерно одинаковое число раз —
 * в отличие от Math.random(), которая может выдать один и тот же вариант
 * несколько раз подряд, а другой — ни разу.
 *
 * Белок для обеда и ужина берётся из ОДНОЙ общей колоды (а не двух разных),
 * чтобы разные виды мяса/рыбы использовались равномерно в течение недели,
 * а не независимо друг для друга. Дополнительно: если на обед и ужин одного
 * дня вытянулся один и тот же белок, для ужина берётся следующая карта.
 *
 * Колоды не сбрасываются между вызовами — они переживают и переключение
 * День/Неделя, и повторные нажатия «Собрать», поэтому баланс держится не
 * только внутри одной генерации, а на всём протяжении использования.
 */

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Колода: перемешивает список один раз и раздаёт карты по очереди,
// пересдавая заново только когда карты заканчиваются. При пересдаче
// колода следит, чтобы новая пачка не начиналась с той же карты, которой
// закончилась предыдущая — иначе один и тот же вариант мог бы выпасть
// два раза подряд ровно на стыке пересдачи.
function createDeck() {
  let queue = [];
  let last;
  return function draw(items, avoid) {
    if (!items || items.length === 0) return null;
    if (items.length === 1) {
      last = items[0];
      return items[0];
    }

    // если список позиций поменялся, выбрасываем из очереди то, чего
    // больше нет, сохраняя порядок оставшегося
    queue = queue.filter((x) => items.includes(x));
    if (queue.length === 0) {
      queue = shuffleArray(items);
      if (last !== undefined && queue[0] === last && queue.length > 1) {
        [queue[0], queue[1]] = [queue[1], queue[0]];
      }
    }

    if (avoid !== undefined && queue[0] === avoid) {
      if (queue.length > 1) {
        [queue[0], queue[1]] = [queue[1], queue[0]];
      } else {
        queue = shuffleArray(items);
        if (queue.length > 1 && queue[0] === avoid) {
          [queue[0], queue[1]] = [queue[1], queue[0]];
        }
      }
    }

    last = queue.shift();
    return last;
  };
}

function createDecks() {
  return {
    base: createDeck(),
    addon: createDeck(),
    protein: createDeck(),
    carb: createDeck(),
    side: createDeck(),
  };
}

function genBreakfast(data, decks) {
  return {
    base: decks.base(data.breakfast.bases),
    addon: decks.addon(data.breakfast.addons),
  };
}
function genLunch(data, decks) {
  return {
    protein: decks.protein(data.shared.proteins),
    carb: decks.carb(data.lunch.carbs),
  };
}
function genDinner(data, decks, avoidProtein) {
  return {
    protein: decks.protein(data.shared.proteins, avoidProtein),
    side: decks.side(data.dinner.sides),
  };
}
function genDay(data, decks) {
  const breakfast = genBreakfast(data, decks);
  const lunch = genLunch(data, decks);
  const dinner = genDinner(data, decks, lunch.protein);
  return { breakfast, lunch, dinner };
}

function genWeek(data, decks) {
  const week = [];
  for (let i = 0; i < DAY_LABELS.length; i++) {
    week.push(genDay(data, decks));
  }
  return week;
}

function mealLines(type, meal) {
  if (!meal) return [];
  if (type === "breakfast") return [meal.base, meal.addon].filter(Boolean);
  if (type === "lunch") return [meal.protein, meal.carb].filter(Boolean);
  return [meal.protein, meal.side].filter(Boolean);
}

/* --------------------------------- стили --------------------------------- */

const CSS = `
  .mdb-root, .mdb-root *, .mdb-root *::before, .mdb-root *::after {
    box-sizing: border-box;
  }
  .mdb-root {
    min-height: 100vh;
    width: 100%;
    padding: 32px;
    background: ${PAGE_BG};
    font-family: ${SANS};
  }
  .mdb-root button {
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    margin: 0;
    cursor: pointer;
  }
  .mdb-root ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .mdb-root h1 {
    margin: 0;
  }
  .mdb-root input {
    font: inherit;
    color: inherit;
  }

  .mdb-wrap {
    max-width: 896px;
    margin: 0 auto;
  }

  .mdb-header {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 32px;
  }
  .mdb-header-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px;
  }
  .mdb-title-group {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .mdb-title {
    font-family: ${SERIF};
    font-size: 30px;
    color: ${INK};
  }
  .mdb-subtitle {
    font-size: 14px;
    color: ${MUTED};
  }
  .mdb-header-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .mdb-tabs {
    display: flex;
    gap: 4px;
    padding: 4px;
    border-radius: 8px;
    background: ${LINE};
  }
  .mdb-tab {
    padding: 6px 14px;
    border-radius: 2px;
    font-size: 14px;
    font-weight: 500;
    white-space: nowrap;
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  .mdb-tab[data-active="true"] {
    background: ${PAPER};
    color: ${INK};
    box-shadow: 0 1px 2px rgba(43, 42, 38, 0.15);
  }
  .mdb-tab[data-active="false"] {
    background: transparent;
    color: ${MUTED};
  }

  .mdb-shuffle-btn {
    font-size: 14px;
    padding: 10px 20px;
    border-radius: 2px;
    background: ${INK};
    color: ${PAPER};
    white-space: nowrap;
  }

  /* --- переключение День / Неделя: обе панели живут в одной ячейке
     сетки, поэтому контейнер всегда высотой в максимум из двух --- */
  .mdb-mode-stack {
    display: grid;
  }
  .mdb-mode-panel {
    grid-column: 1;
    grid-row: 1;
    min-width: 0;
  }
  .mdb-mode-panel[data-visible="false"] {
    visibility: hidden;
    pointer-events: none;
  }

  .mdb-day-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 16px;
    align-items: stretch;
  }
  .mdb-week-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
    align-items: stretch;
  }
  @media (min-width: 768px) {
    .mdb-day-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .mdb-week-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  }

  .mdb-card {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    border-radius: 2px;
    border: 1px solid ${LINE};
    padding: 20px;
    background: ${PAPER};
  }
  .mdb-dot {
    position: absolute;
    top: 16px;
    right: 16px;
    height: 10px;
    width: 10px;
    border-radius: 999px;
  }
  .mdb-card-title {
    font-family: ${SERIF};
    font-size: 18px;
    margin-bottom: 12px;
    color: ${INK};
  }
  .mdb-lines {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .mdb-line {
    font-size: 15px;
    line-height: 1.35;
    overflow-wrap: break-word;
    color: ${INK};
  }
  .mdb-line-empty {
    font-size: 14px;
    font-style: italic;
    color: ${MUTED};
  }

  .mdb-week-card {
    display: flex;
    flex-direction: column;
    min-width: 0;
    border-radius: 2px;
    border: 1px solid ${LINE};
    padding: 16px;
    background: ${PAPER};
  }
  .mdb-week-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .mdb-week-day-label {
    font-family: ${SERIF};
    font-size: 16px;
    color: ${INK};
  }
  .mdb-week-shuffle {
    font-size: 14px;
  }
  .mdb-week-meals {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .mdb-week-meal {
    padding-left: 10px;
    border-left: 2px solid;
    min-width: 0;
  }
  .mdb-week-meal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    margin-bottom: 2px;
  }
  .mdb-week-meal-label {
    font-size: 10px;
    letter-spacing: 0.02em;
  }
  .mdb-week-meal-text {
    font-size: 13px;
    line-height: 1.35;
    overflow-wrap: break-word;
    color: ${INK};
    display: -webkit-box;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .mdb-week-meal-text[data-lines="1"] {
    min-height: 1.35em;
    -webkit-line-clamp: 1;
  }
  .mdb-week-meal-text[data-lines="2"] {
    min-height: 2.7em;
    -webkit-line-clamp: 2;
  }

  .mdb-editors-grid {
    margin-top: 48px;
    display: grid;
    grid-template-columns: 1fr;
    gap: 16px;
  }
  @media (min-width: 768px) {
    .mdb-editors-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .mdb-editors-grid > [data-span2="true"] { grid-column: span 2 / span 2; }
  }
  .mdb-editor {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    border-radius: 2px;
    border: 1.5px dashed ${LINE};
    padding: 20px;
    background: ${PAPER};
  }
  .mdb-plus {
    position: absolute;
    top: 16px;
    right: 16px;
    height: 20px;
    width: 20px;
    border-radius: 999px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    line-height: 1;
  }
  .mdb-editor-title {
    font-family: ${SERIF};
    font-size: 18px;
    margin-bottom: 12px;
    color: ${INK};
  }
  .mdb-chips {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    gap: 8px;
    margin-bottom: 16px;
    min-height: 30px;
  }
  .mdb-chip-empty {
    font-size: 14px;
    font-style: italic;
    color: ${MUTED};
  }
  .mdb-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    padding: 4px 10px;
    border-radius: 2px;
    border: 1px solid ${LINE};
    background: #fff;
    color: ${INK};
    max-width: 100%;
    overflow-wrap: break-word;
  }
  .mdb-chip button {
    color: ${MUTED};
    flex-shrink: 0;
  }
  .mdb-editor-form {
    margin-top: auto;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .mdb-editor-input {
    min-width: 0;
    flex: 1 1 120px;
    max-width: 100%;
    font-size: 14px;
    padding: 6px 10px;
    border-radius: 2px;
    border: 1px solid ${LINE};
    background: #fff;
    color: ${INK};
    outline: none;
  }
  .mdb-editor-add {
    flex-shrink: 0;
    font-size: 14px;
    padding: 6px 12px;
    border-radius: 2px;
    color: #fff;
  }

  .mdb-auth-screen {
    min-height: 100vh;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: ${PAGE_BG};
    font-family: ${SANS};
    padding: 24px;
  }
  .mdb-auth-card {
    width: 100%;
    max-width: 340px;
    border-radius: 2px;
    border: 1px solid ${LINE};
    background: ${PAPER};
    padding: 24px;
  }
  .mdb-auth-title {
    font-family: ${SERIF};
    font-size: 22px;
    color: ${INK};
    margin-bottom: 16px;
  }
  .mdb-auth-field {
    width: 100%;
    font-size: 14px;
    padding: 8px 10px;
    margin-bottom: 10px;
    border-radius: 2px;
    border: 1px solid ${LINE};
    background: #fff;
    color: ${INK};
    outline: none;
  }
  .mdb-auth-error {
    font-size: 13px;
    color: #a63a2a;
    margin-bottom: 10px;
  }
  .mdb-auth-actions {
    display: flex;
    gap: 8px;
  }
  .mdb-auth-btn {
    flex: 1;
    font-size: 14px;
    padding: 8px 0;
    border-radius: 2px;
    color: #fff;
    background: ${INK};
  }
  .mdb-auth-btn[data-variant="secondary"] {
    background: transparent;
    color: ${INK};
    border: 1px solid ${LINE};
  }
  .mdb-icon-group {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .mdb-icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 2px;
    border: 1px solid ${LINE};
    background: ${PAPER};
    color: ${MUTED};
  }
  .mdb-icon-btn svg {
    width: 18px;
    height: 18px;
  }
`;

function GlobalStyles() {
  return <style>{CSS}</style>;
}

/* ------------------------------- иконки ----------------------------------- */

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4v11" />
      <path d="M7.5 11.5L12 16l4.5-4.5" />
      <path d="M5 19.5h14" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15V4" />
      <path d="M7.5 8.5L12 4l4.5 4.5" />
      <path d="M5 19.5h14" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 19H5.5A1.5 1.5 0 014 17.5v-11A1.5 1.5 0 015.5 5H10" />
      <path d="M15.5 16L20 12l-4.5-4" />
      <path d="M20 12H9" />
    </svg>
  );
}

/* ------------------------------- компоненты ------------------------------ */

function MealCard({ type, meal }) {
  const meta = MEAL_META[type];
  const lines = mealLines(type, meal);

  return (
    <div className="mdb-card">
      <span className="mdb-dot" style={{ background: meta.accent }} />
      <div className="mdb-card-title">{meta.label}</div>

      <ul className="mdb-lines">
        {lines.length === 0 ? (
          <li className="mdb-line-empty">Добавьте позиции ниже</li>
        ) : (
          lines.map((line, i) => (
            <li key={i} className="mdb-line">
              {line}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function WeekDayCard({ label, day, onShuffleDay }) {
  return (
    <div className="mdb-week-card">
      <div className="mdb-week-head">
        <span className="mdb-week-day-label">{label}</span>
        <button
          onClick={onShuffleDay}
          className="mdb-week-shuffle"
          style={{ color: MUTED }}
          aria-label={`Перемешать ${label}`}
          title="Перемешать день"
        >
          🔀
        </button>
      </div>

      <div className="mdb-week-meals">
        {["breakfast", "lunch", "dinner"].map((type) => {
          const meta = MEAL_META[type];
          const lines = mealLines(type, day[type]);

          return (
            <div key={type} className="mdb-week-meal" style={{ borderLeftColor: meta.accent }}>
              <div className="mdb-week-meal-head">
                <span className="mdb-week-meal-label" style={{ color: meta.accent }}>
                  {meta.label}
                </span>
              </div>
              <div className="mdb-week-meal-text" data-lines={type === "breakfast" ? "1" : "2"}>
                {lines.length ? lines.join(" · ") : "—"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CategoryFields({ label, accent, items, onAdd, onRemove }) {
  const [value, setValue] = useState("");

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onAdd(v);
    setValue("");
  };

  return (
    <>
      <div className="mdb-editor-title">{label}</div>

      <div className="mdb-chips">
        {items.length === 0 ? (
          <span className="mdb-chip-empty">Пока пусто</span>
        ) : (
          items.map((item, i) => (
            <span key={i} className="mdb-chip">
              {item}
              <button onClick={() => onRemove(i)} aria-label={`Удалить ${item}`}>
                ✕
              </button>
            </span>
          ))
        )}
      </div>

      <div className="mdb-editor-form">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Новая позиция"
          className="mdb-editor-input"
        />
        <button onClick={submit} className="mdb-editor-add" style={{ background: accent }}>
          Добавить
        </button>
      </div>
    </>
  );
}

function PlusMark({ accent }) {
  return (
    <span className="mdb-plus" style={{ border: `1.5px solid ${accent}`, color: accent }}>
      +
    </span>
  );
}

function CategoryEditor({ label, accent, items, onAdd, onRemove, span2 }) {
  return (
    <div className="mdb-editor" data-span2={span2 ? "true" : "false"}>
      <PlusMark accent={accent} />
      <CategoryFields label={label} accent={accent} items={items} onAdd={onAdd} onRemove={onRemove} />
    </div>
  );
}

function AuthScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (action) => {
    setError("");
    setBusy(true);
    try {
      await action(auth, email.trim(), password);
    } catch (e) {
      setError(e.message.replace("Firebase: ", ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mdb-auth-screen">
      <div className="mdb-auth-card">
        <div className="mdb-auth-title">Вход</div>
        {error && <div className="mdb-auth-error">{error}</div>}
        <input
          className="mdb-auth-field"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="mdb-auth-field"
          type="password"
          placeholder="Пароль"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="mdb-auth-actions">
          <button
            className="mdb-auth-btn"
            disabled={busy}
            onClick={() => run(signInWithEmailAndPassword)}
          >
            Войти
          </button>
          <button
            className="mdb-auth-btn"
            data-variant="secondary"
            disabled={busy}
            onClick={() => run(createUserWithEmailAndPassword)}
          >
            Регистрация
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- корень -------------------------------- */

export default function MealDayBuilder() {
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [mode, setMode] = useState("week"); // "day" | "week"
  const [data, setData] = useState(EMPTY_DATA);
  const decksRef = useRef(createDecks());
  const fileInputRef = useRef(null);
  const [plan, setPlan] = useState(() => genDay(EMPTY_DATA, decksRef.current));
  const [weekPlan, setWeekPlan] = useState(() => genWeek(EMPTY_DATA, decksRef.current));

  // Следим за состоянием авторизации
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthChecked(true);
      setLoaded(false);
    });
    return unsub;
  }, []);

  // Подписываемся на документ пользователя в Firestore и держим data в синхроне
  useEffect(() => {
    if (!user) return;
    const ref = doc(db, "mealPlanner", user.uid);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setData(snap.exists() ? snap.data() : EMPTY_DATA);
        setLoaded(true);
        setLoadError("");
      },
      (err) => {
        setLoadError(err.message);
      }
    );
    return unsub;
  }, [user]);

  // Сохраняет новое значение data и локально, и в Firestore
  const persist = (next) => {
    setData(next);
    if (user) setDoc(doc(db, "mealPlanner", user.uid), next);
  };

  const addItem = (mealType, category, value) =>
    persist({
      ...data,
      [mealType]: { ...data[mealType], [category]: [...data[mealType][category], value] },
    });

  const removeItem = (mealType, category, index) =>
    persist({
      ...data,
      [mealType]: {
        ...data[mealType],
        [category]: data[mealType][category].filter((_, i) => i !== index),
      },
    });

  // Скачивает текущее наполнение категорий в JSON-файл
  const handleExport = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "meal-day-builder-data.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  // Открывает системный диалог выбора JSON-файла
  const handleImportClick = () => fileInputRef.current?.click();

  // Читает выбранный файл и загружает его как новое наполнение категорий
  const handleImportFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        persist(parsed);
      } catch (err) {
        alert("Не удалось прочитать файл: " + err.message);
      }
    };
    reader.readAsText(file);
  };

  const shuffleAll = () => setPlan(genDay(data, decksRef.current));

  const shuffleWeekAll = () => setWeekPlan(genWeek(data, decksRef.current));

  const shuffleOneDay = (dayIndex) =>
    setWeekPlan((prevWeek) => {
      const next = [...prevWeek];
      next[dayIndex] = genDay(data, decksRef.current);
      return next;
    });

  if (!authChecked) {
    return (
      <>
        <GlobalStyles />
        <div className="mdb-auth-screen" />
      </>
    );
  }

  if (!user) {
    return (
      <>
        <GlobalStyles />
        <AuthScreen />
      </>
    );
  }

  if (!loaded) {
    return (
      <>
        <GlobalStyles />
        <div className="mdb-auth-screen">
          {loadError && (
            <div className="mdb-auth-card">
              <div className="mdb-auth-error">Ошибка Firestore: {loadError}</div>
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="mdb-root">
      <GlobalStyles />
      <div className="mdb-wrap">
        <div className="mdb-header">
          <div className="mdb-header-top">
            <div className="mdb-title-group">
              <h1 className="mdb-title">Конструктор</h1>
              <div className="mdb-icon-group">
                <button className="mdb-icon-btn" onClick={handleExport} title="Скачать данные" aria-label="Скачать данные">
                  <DownloadIcon />
                </button>
                <button className="mdb-icon-btn" onClick={handleImportClick} title="Загрузить данные" aria-label="Загрузить данные">
                  <UploadIcon />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json"
                  onChange={handleImportFile}
                  style={{ display: "none" }}
                />
                <button className="mdb-icon-btn" onClick={() => signOut(auth)} title="Выйти" aria-label="Выйти">
                  <LogoutIcon />
                </button>
              </div>
            </div>
            <div className="mdb-header-controls">
              <button onClick={mode === "day" ? shuffleAll : shuffleWeekAll} className="mdb-shuffle-btn">
                🎲 Собрать
              </button>
              <div className="mdb-tabs">
                {[
                  ["day", "День"],
                  ["week", "Неделя"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setMode(id)}
                    className="mdb-tab"
                    data-active={mode === id ? "true" : "false"}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="mdb-subtitle">Наполните списки ниже своими позициями — генератор сам будет их смешивать</p>
        </div>

        <div className="mdb-mode-stack">
          <div className="mdb-mode-panel" data-visible={mode === "day" ? "true" : "false"}>
            <div className="mdb-day-grid">
              {["breakfast", "lunch", "dinner"].map((type) => (
                <MealCard key={type} type={type} meal={plan[type]} />
              ))}
            </div>
          </div>

          <div className="mdb-mode-panel" data-visible={mode === "week" ? "true" : "false"}>
            <div className="mdb-week-grid">
              {weekPlan.map((day, i) => (
                <WeekDayCard key={i} label={DAY_LABELS[i]} day={day} onShuffleDay={() => shuffleOneDay(i)} />
              ))}
            </div>
          </div>
        </div>

        <div className="mdb-editors-grid">
          <CategoryEditor
            label="Каша"
            accent={MEAL_META.breakfast.accent}
            items={data.breakfast.bases}
            onAdd={(value) => addItem("breakfast", "bases", value)}
            onRemove={(index) => removeItem("breakfast", "bases", index)}
          />

          <CategoryEditor
            span2
            label="Основа"
            accent={SHARED_ACCENT}
            items={data.shared.proteins}
            onAdd={(value) => addItem("shared", "proteins", value)}
            onRemove={(index) => removeItem("shared", "proteins", index)}
          />

          <CategoryEditor
            label="Допы"
            accent={MEAL_META.breakfast.accent}
            items={data.breakfast.addons}
            onAdd={(value) => addItem("breakfast", "addons", value)}
            onRemove={(index) => removeItem("breakfast", "addons", index)}
          />
          <CategoryEditor
            label="Крупа"
            accent={MEAL_META.lunch.accent}
            items={data.lunch.carbs}
            onAdd={(value) => addItem("lunch", "carbs", value)}
            onRemove={(index) => removeItem("lunch", "carbs", index)}
          />
          <CategoryEditor
            label="Гарнир"
            accent={MEAL_META.dinner.accent}
            items={data.dinner.sides}
            onAdd={(value) => addItem("dinner", "sides", value)}
            onRemove={(index) => removeItem("dinner", "sides", index)}
          />
        </div>
      </div>
    </div>
  );
}
