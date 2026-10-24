import { Moon, Minus, Plus } from 'lucide-preact';
import { settings, saveSettings } from '../lib/data';

const STEPS = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120];
const step = (cur: number, d: number) => {
  const i = STEPS.findIndex((s) => s >= cur);
  const at = i < 0 ? STEPS.length - 1 : i;
  const exact = STEPS[at] === cur;
  return STEPS[Math.max(0, Math.min(STEPS.length - 1, d > 0 ? (exact ? at + 1 : at) : at - 1))];
};

export function Settings() {
  const s = settings.value;
  return (
    <div class="page-pad set-page">
      <div class="cal-head"><h1 class="page-title">Settings</h1></div>
      <div class="set-list" data-group="settings">
        <div class="set-row tile">
          <div class="set-ic"><Moon size="2rem" /></div>
          <div class="set-txt">
            <div class="set-t">Idle screen</div>
            <div class="set-d dim">Fade to the landscape + clock screen after a while without controller input. Y opens it any time.</div>
          </div>
          <button class={'set-toggle focusable' + (s.idleEnabled ? ' on' : '')} data-fkey="set-idle-on" data-autofocus onClick={() => saveSettings({ idleEnabled: !s.idleEnabled })}>
            <span class="knob" />
            <span class="lbl">{s.idleEnabled ? 'On' : 'Off'}</span>
          </button>
        </div>
        <div class={'set-row tile' + (s.idleEnabled ? '' : ' disabled')}>
          <div class="set-ic" />
          <div class="set-txt">
            <div class="set-t">Idle after</div>
            <div class="set-d dim">Minutes without input before the idle screen appears.</div>
          </div>
          <div class="set-stepper" data-block="left right">
            <button class="np-btn sm focusable" data-fkey="set-idle-dn" onClick={() => saveSettings({ idleMinutes: step(s.idleMinutes, -1) })}><Minus size="1.8rem" /></button>
            <span class="set-val">{s.idleMinutes} min</span>
            <button class="np-btn sm focusable" data-fkey="set-idle-up" onClick={() => saveSettings({ idleMinutes: step(s.idleMinutes, 1) })}><Plus size="1.8rem" /></button>
          </div>
        </div>
      </div>
    </div>
  );
}
