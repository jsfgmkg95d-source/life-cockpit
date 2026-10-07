import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DesktopWidget from './DesktopWidget';
import { initializeTheme } from './theme';
import './styles.css';
import './control-polish.css';
import './apple-cockpit.css';
import './planner-design.css';
import './ui-refinement.css';
import './ui-surfaces.css';
import './cockpit-density.css';
import './cockpit-graphics.css';
import './cockpit-vital.css';
import './odette-portrait.css';
import './themes.css';
import './readability.css';
import './desktop-widget.css';
import './app-identity.css';
import './spacious-layout.css';

initializeTheme();
const isDesktopWidget = new URLSearchParams(window.location.search).get('view') === 'widget';
if (isDesktopWidget) { document.documentElement.dataset.desktopWidget = 'true'; document.title = '人生驾驶舱 · 桌面小组件'; }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isDesktopWidget ? <DesktopWidget /> : <App />}</React.StrictMode>,
);
