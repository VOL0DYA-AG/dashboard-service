import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createApi } from "./api";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Нет корневого элемента");

createApi()
  .then((api) => {
    createRoot(root).render(
      <StrictMode>
        <App api={api} />
      </StrictMode>,
    );
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Не удалось открыть кабинет";
    root.textContent = message;
  });
