import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { createHttpApi } from './api/httpApi';
import './index.css';
import { notifySessionExpired } from './lib/authEvents';
import { ApiContext } from './state/context';
import { AuthProvider } from './state/AuthStore';

// The browser talks to the Tajir server only. The Vite dev server forwards /api to it.
const api = createHttpApi({ onUnauthorized: notifySessionExpired });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApiContext.Provider value={api}>
      <AuthProvider api={api}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AuthProvider>
    </ApiContext.Provider>
  </StrictMode>,
);
