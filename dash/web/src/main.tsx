import { render } from 'preact';
import '@fontsource-variable/inter';
import './styles/app.css';
import { installErrorHooks, log } from './lib/log';
import { startData } from './lib/data';
import { startRemote } from './lib/input';
import { App } from './App';

installErrorHooks();
startData();
startRemote(() => {}); // debug key queue: POST /api/cmd?c=xbox {"keys":[199]}
render(<App />, document.getElementById('app')!);
log('rendered');
