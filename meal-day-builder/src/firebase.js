// Инициализация Firebase — этот файл лежит в src/firebase.js.
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAkIS1UIIx0Nem7hR4zeVMrZZMTseU4xYE",
  authDomain: "meal-day-builder.firebaseapp.com",
  projectId: "meal-day-builder",
  storageBucket: "meal-day-builder.firebasestorage.app",
  messagingSenderId: "922105208461",
  appId: "1:922105208461:web:59da97e2a326c28a54ccc4",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
