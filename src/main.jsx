// main.jsx
import React from "react";
import ReactDOM from "react-dom/client";
import RouterApp from "./RouterApp";
import "./index.css"; // keep your global styles

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RouterApp />
  </React.StrictMode>
);
