import { createRoot } from 'react-dom/client';
import App from './App';
import { installAuthNotice } from './web/utils/authNotice';

installAuthNotice();

createRoot(document.getElementById('root')!).render(<App />);
