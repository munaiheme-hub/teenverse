import React from 'react'
import ReactDOM from 'react-dom/client'
import * as MyAppComponent from './App.jsx'

const TargetApp = MyAppComponent.default || MyAppComponent.App || Object.values(MyAppComponent)[0];

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <TargetApp />
  </React.StrictMode>,
)
