import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { FeedbackProvider } from './context/FeedbackContext.jsx';
import { SessionProvider } from './context/SessionContext.jsx';
import './styles/main.scss';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <FeedbackProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </FeedbackProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
