import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// Fallback safeguard in case default export is ever missed
const RootComponent = App.default || App;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RootComponent />
  </React.StrictMode>,
)
