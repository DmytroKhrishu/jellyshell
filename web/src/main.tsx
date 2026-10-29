import { render } from 'preact';
import '@fontsource-variable/inter';
import './styles/app.css';
import './lib/mode'; // sets html.mode-tv|desktop|mobile before the first render
import { installErrorHooks, log } from './lib/log';
import { App } from './App';
import './lib/wake'; // Xbox: reload after a long suspend (blank-text render loss)
import './lib/renderprobe'; // Xbox: detect the blank-text render loss while it happens, log it, reload
import { settings } from './lib/settings';

installErrorHooks();
void settings.value; // apply reduce-motion class
render(<App />, document.getElementById('app')!);
log('rendered');
