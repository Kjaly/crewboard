import type { ViewStatus } from '../shared/types.js'
import { isChecking } from '../../../core/src/plan/graph.js'
import type { CheckState } from '../../../core/src/plan/schema.js'
import { t } from './i18n.js'
import { STATUS_GLYPH, STATUS_LABEL } from './summary.js'

/**
 * One stylesheet for the whole screen. Colours and type come from dsh tokens only (with a literal
 * fallback), so the panel inherits the shell's theme instead of inventing a second visual world.
 */
const CSS = `
/* Токены живут и на экране настроек, и на тостах, и на вкладке правой панели: они монтируются вне .orc-root. */
.orc-root,.orc-settings,.orc-toasts,.orc-rp{
  --orc-bg:var(--dsw-alias-bg-base,#151517);
  --orc-layer1:var(--dsw-alias-bg-layer-1,#232324);
  --orc-layer2:var(--dsw-alias-bg-layer-2,#2c2c2e);
  --orc-hair:var(--dsw-alias-border-l1,#ffffff0f);
  --orc-line:var(--dsw-alias-border-l2,#ffffff1f);
  --orc-sep:var(--dsw-alias-separator-primary,#ffffff14);
  --orc-fg:var(--dsw-alias-label-primary,#f9fafb);
  --orc-fg2:var(--dsw-alias-label-secondary,#cfd3d6);
  --orc-fg3:var(--dsw-alias-label-tertiary,#adb2b8);
  --orc-warn:var(--dsw-alias-state-warn-primary,#f59e0b);
  --orc-error:var(--dsw-alias-state-error-primary,#f25a5a);
  --orc-ok:var(--dsw-alias-state-success-primary,#22c55e);
  --orc-accent:var(--dsw-static-blue-400,#60a5fa);
  --orc-accent-strong:var(--dsw-static-blue-500,#3b82f6);
  --orc-prov-deepseek:var(--dsw-static-blue-400,#60a5fa);
  --orc-prov-claude:var(--dsw-static-orange-400,#fb923c);
  --orc-prov-codex:var(--dsw-static-green-400,#4ade80);
  --orc-prov-devin:var(--dsw-static-purple-400,#a78bfa);
  --orc-hover:var(--dsw-alias-interactive-bg-hover,#ffffff0d);
  --orc-active:var(--dsw-alias-interactive-bg-active,#ffffff17);
  --orc-mono:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);
  /* Action types on the trace and the timeline. Colour encodes what was done — never who did it. */
  --orc-k-input:var(--dsw-alias-label-primary,#f9fafb);
  --orc-k-model:var(--dsw-static-blue-400,#60a5fa);
  --orc-k-read:var(--dsw-static-teal-400,#2dd4bf);
  --orc-k-edit:var(--dsw-alias-state-warn-primary,#f59e0b);
  --orc-k-cmd:var(--dsw-static-purple-400,#a78bfa);
  --orc-k-tool:var(--dsw-alias-label-tertiary,#adb2b8);
  --orc-k-problem:var(--dsw-alias-state-error-primary,#f25a5a);
}
.orc-root{
  /* The screen is a grid: [rail | main]. The rail owns its column edge-to-edge, so the header never
     spans over it; the centring gutter is spent inside .orc-main, where header and body share it. */
  --orc-max:1680px;
  --orc-gut:max(14px,(100% - var(--orc-max)) / 2);
  --orc-rail-w:248px;
  display:grid;grid-template-columns:var(--orc-rail-w) minmax(0,1fr);grid-template-rows:minmax(0,1fr);
  height:100%;min-height:0;position:relative;
  background:var(--orc-bg);color:var(--orc-fg);
  font:var(--dsw-font-xs-13,13px/20px system-ui,-apple-system,sans-serif);
  transition:grid-template-columns 180ms cubic-bezier(.23,1,.32,1);
}
.orc-root--rail-shut{--orc-rail-w:44px}
.orc-root>.orc-empty{grid-column:1 / -1}
.orc-main{display:flex;flex-direction:column;min-width:0;min-height:0}
.orc-toasts{color:var(--orc-fg);font:var(--dsw-font-xs-13,13px/20px system-ui,-apple-system,sans-serif)}
.orc-root *,.orc-settings *,.orc-toasts *,.orc-rp *{box-sizing:border-box}
.orc-root :focus-visible,.orc-settings :focus-visible,.orc-toasts :focus-visible,.orc-rp :focus-visible{outline:2px solid var(--orc-accent);outline-offset:1px;border-radius:6px}

/* Header */
/* The header is chrome: it spans the full width like the rail and the task panel, while the view
   below keeps the centring gutter. */
.orc-top{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;min-width:0;padding:8px 14px;border-bottom:1px solid var(--orc-hair);background:var(--orc-layer1)}
.orc-goal{font:var(--dsw-font-strong-xs-13,600 13px/20px system-ui,sans-serif);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:60px;max-width:24ch;flex:0 1 auto}
.orc-preset{position:relative;display:inline-flex;align-items:center;flex:none;min-width:0}
.orc-preset__trigger{max-width:190px}
.orc-preset__summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-preset__popover{position:absolute;z-index:40;right:0;top:calc(100% + 6px);width:min(360px,calc(100vw - 28px));max-height:min(70vh,520px);overflow:auto;display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--orc-line);border-radius:9px;background:var(--orc-layer2);box-shadow:0 8px 24px #00000059}
.orc-preset__title{margin:0;color:var(--orc-fg);font:var(--dsw-font-strong-xs-13,600 13px/20px system-ui,sans-serif)}
.orc-preset__field{display:grid;grid-template-columns:88px minmax(0,1fr);align-items:center;gap:8px;color:var(--orc-fg2);font-size:12px}
.orc-preset__field>span:first-child{color:var(--orc-fg3)}
.orc-preset__fallback{color:var(--orc-fg3)}
.orc-preset__field .orc-select{width:100%}
.orc-preset__effective{margin:4px 0 0;padding-top:8px;border-top:1px solid var(--orc-hair);color:var(--orc-fg3);font-size:12px}
.orc-preset__order{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 12px;color:var(--orc-fg2);font-size:12px;line-height:18px}
.orc-preset__route{display:grid;grid-column:1 / -1;grid-template-columns:subgrid}
.orc-preset__route>[role=cell]:last-child{overflow-wrap:anywhere}
.orc-preset__settings{align-self:flex-start;margin-top:2px;padding:4px 0;border:0;background:transparent;color:var(--orc-accent);font:inherit;font-size:12px;cursor:pointer}.orc-preset__settings:hover{text-decoration:underline}
.orc-broken{display:grid;gap:8px;justify-items:start;margin:24px;padding:14px 16px;border:1px solid var(--orc-line);border-radius:8px;background:var(--orc-layer1);color:var(--orc-fg2);font-size:13px}.orc-broken p{margin:0;color:var(--orc-fg)}.orc-broken code{font:12px/18px var(--orc-mono);color:var(--orc-fg3);overflow-wrap:anywhere}
.orc-conn--stale{color:var(--orc-warn,#d6a444)}
.orc-settings-banner{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin:8px 12px 0;padding:8px 12px;border:1px solid color-mix(in srgb,var(--orc-warn) 45%,var(--orc-line));border-radius:7px;background:color-mix(in srgb,var(--orc-warn) 10%,var(--orc-layer1));color:var(--orc-fg);font-size:13px}.orc-settings-banner p{margin:0;flex:1 1 320px}.orc-settings-banner code{font:12px/18px var(--orc-mono);color:var(--orc-fg3);overflow-wrap:anywhere;flex-basis:100%}
.orc-settings-screen{max-width:880px;margin:0 auto;padding:20px 20px 48px}
.orc-settings-screen__head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.orc-settings-screen__head h1{margin:0;color:var(--orc-fg);font-size:18px;line-height:26px;font-weight:650}
.orc-preset__dropped{margin:0;color:var(--orc-fg2);font-size:12px}
.orc-preset__order strong{color:var(--orc-fg);font-weight:600}
.orc-view-menu{display:none}
.orc-main{container-type:inline-size}
.orc-work__totals{margin:12px 0 0;color:var(--orc-fg2);font-size:12px}
.orc-work__lane{margin:12px 0 0}
.orc-work__lanechip{display:inline-flex;align-items:center;gap:6px}
.orc-work__laneclear{padding:0 4px;border:0;border-radius:5px;background:transparent;color:var(--orc-fg3);font:inherit;line-height:1;cursor:pointer}
.orc-work__laneclear:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-work__toggle{border:0;background:none;color:inherit;cursor:pointer;text-align:left}
.orc-work__filters{display:flex;flex-wrap:wrap;gap:5px;padding:8px}
.orc-work__last{margin:0 8px 8px;color:var(--orc-fg3);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Review (rv6): one urgent band, a compact plan explanation, three small resource cells, then
   evidence-first run rows. Status colour always travels with a word; trace colour means what happened. */
.orc-review{container-type:inline-size;display:grid;gap:24px;padding:26px 20px 60px;max-width:1240px;margin:0 auto}
@media (max-width:1279px){.orc-review{padding:24px 10px 48px}}
.orc-eyebrow{margin:0;color:var(--orc-fg3);font-size:11px;line-height:16px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.orc-review__top h1{margin:4px 0 2px;font-size:26px;line-height:32px;letter-spacing:-.02em}
.orc-review__top>p:last-child{margin:0;color:var(--orc-fg3);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-review__head{display:flex;justify-content:space-between;align-items:baseline;gap:6px 12px;flex-wrap:wrap;margin:0 0 10px}
.orc-review__head h2{font-size:16px;line-height:22px;margin:0}
.orc-review__head>span{color:var(--orc-fg3);font-size:11px}
.orc-review__note{margin:8px 0 0;color:var(--orc-fg3);font-size:11px;line-height:16px}
.orc-review__quiet{margin:0;color:var(--orc-fg2)}
/* Needs you */
.orc-needs{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:18px 20px;border:1px solid var(--orc-line);border-radius:12px;background:var(--orc-layer1)}
.orc-needs--warn{border-color:color-mix(in srgb,var(--orc-warn) 40%,var(--orc-line));background:linear-gradient(100deg,color-mix(in srgb,var(--orc-warn) 16%,var(--orc-layer1)),var(--orc-layer1) 70%)}
.orc-needs--calm{border-color:color-mix(in srgb,var(--orc-ok) 30%,var(--orc-line));background:linear-gradient(100deg,color-mix(in srgb,var(--orc-ok) 9%,var(--orc-layer1)),var(--orc-layer1) 60%)}
.orc-needs__text{min-width:0}
.orc-needs h2{margin:2px 0 5px;font-size:19px;line-height:26px}
.orc-needs p{margin:0;color:var(--orc-fg2)}
.orc-needs__tasks{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px}
.orc-needs__task{max-width:100%;padding:0;border:0;background:none;color:var(--orc-fg);font:inherit;font-weight:600;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-needs__task:hover{text-decoration:underline}
.orc-needs__failed{margin-top:6px!important}.orc-needs__failed b{color:var(--orc-error);font-weight:650}.orc-needs__unmerged{margin-top:6px!important}.orc-needs__unmerged b{color:var(--orc-warn);font-weight:650}
.orc-needs__act{display:flex;align-items:center;gap:12px;flex:none}
.orc-needs__count{font-size:34px;line-height:1;font-weight:750;font-variant-numeric:tabular-nums;color:var(--orc-fg3)}
.orc-needs--warn .orc-needs__count{color:var(--orc-warn)}.orc-needs--calm .orc-needs__count{color:var(--orc-ok)}
.orc-needs__action{padding:8px 12px;border:1px solid var(--orc-line);border-radius:8px;background:var(--orc-layer2);color:var(--orc-fg2);font:inherit;font-weight:650;white-space:nowrap;cursor:pointer}
.orc-needs--warn .orc-needs__action{border-color:transparent;background:var(--orc-warn);color:#1d1707}
/* Progress and time: about 60/40 */
.orc-review__overview{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(240px,.9fr);gap:22px;align-items:start}
.orc-rprogress__number{margin:0 0 12px;font-size:28px;line-height:32px;font-weight:720;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.orc-rprogress__number small{font-size:12px;font-weight:450;letter-spacing:0;color:var(--orc-fg3)}
.orc-rprogress__bar{display:flex;gap:2px;height:11px;border-radius:999px;overflow:hidden;background:var(--orc-layer2)}
.orc-rprogress__bar i{display:block;height:100%;min-width:3px}
.orc-rprogress__key{display:flex;flex-wrap:wrap;gap:5px 15px;margin:11px 0 0;padding:0;list-style:none;color:var(--orc-fg2);font-size:12px}
.orc-rprogress__key i,.orc-strip-legend i{display:inline-block;width:7px;height:7px;margin-right:5px;border-radius:50%}
.orc-rprogress__key b{color:var(--orc-fg);font-variant-numeric:tabular-nums}
.orc-rprogress__caveat{margin:8px 0 0;color:var(--orc-fg3);font-size:11px;line-height:16px}
.orc-rtime{padding:14px 16px;border:1px solid var(--orc-hair);border-radius:10px;background:var(--orc-layer1);min-width:0}
.orc-rtime h2{margin:0 0 2px}
.orc-rtime__elapsed{display:block;font-size:18px;line-height:24px;font-variant-numeric:tabular-nums}
.orc-rtime>small{color:var(--orc-fg3);font-size:11px}
.orc-rtime__lines{display:flex;gap:12px;margin-top:8px}
.orc-rtime__lines>div{flex:1;min-width:0}
.orc-rtime__lines span{display:block;color:var(--orc-fg3);font-size:11px}
.orc-rtime__lines strong{font-variant-numeric:tabular-nums}
.orc-rtime__line{height:4px;margin-top:6px;border-radius:4px;overflow:hidden;background:var(--orc-layer2)}
.orc-rtime__line i{display:block;height:100%;border-radius:4px}
/* Money and quota: three units, never summed */
.orc-resources__grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.orc-resource{min-width:0;padding:13px 15px;border-top:2px solid var(--orc-line);border-radius:4px 4px 9px 9px;background:var(--orc-layer1)}
.orc-resource--quota{border-top-color:var(--orc-warn)}.orc-resource--estimate{border-top-color:var(--orc-accent)}.orc-resource--cash{border-top-color:var(--orc-k-cmd)}
.orc-resource h3{margin:0 0 5px;font-size:12px;color:var(--orc-fg2)}
.orc-resource>strong{display:block;font-size:19px;line-height:25px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.orc-resource__windows{display:grid;gap:2px}.orc-resource__windows small{font-size:11px;font-weight:450;color:var(--orc-fg3)}
.orc-resource p{margin:5px 0 9px;min-height:32px;color:var(--orc-fg3);font-size:11px;line-height:16px}
.orc-resource__bar{display:block;height:5px;border-radius:5px;overflow:hidden;background:var(--orc-layer2)}
.orc-resource__bar i{display:block;height:100%;background:var(--orc-fg3)}
.orc-resource>small{display:block;margin-top:6px;color:var(--orc-fg3);font-size:11px;line-height:16px}
/* Runs to inspect */
.orc-review__runs{min-width:0}
.orc-review__runs-head{display:flex;justify-content:space-between;align-items:flex-end;gap:10px 16px;flex-wrap:wrap;margin-bottom:6px}
.orc-review__runs-head h2{margin:0;font-size:17px;line-height:24px}
.orc-review__status{margin:2px 0 0;color:var(--orc-fg3);font-size:11px}
.orc-review__controls{display:flex;align-items:end;gap:8px;flex-wrap:wrap}
.orc-review__search input{min-width:220px;min-height:32px;padding:6px 9px;border:1px solid var(--orc-line);border-radius:7px;background:var(--orc-layer1);color:var(--orc-fg);font:inherit}
.orc-review__more-filters{margin:0 0 10px}
.orc-review__more-filters>summary{display:inline-block;padding:4px 0;color:var(--orc-accent);font-size:12px;cursor:pointer}
.orc-review__filters{display:flex;align-items:end;flex-wrap:wrap;gap:8px;margin:8px 0 4px;padding:10px;border:1px solid var(--orc-hair);border-radius:8px;background:var(--orc-layer1)}
.orc-review__filter{display:grid;gap:3px;min-width:110px;max-width:220px;color:var(--orc-fg2);font-size:12px}
.orc-review__filter input,.orc-review__filter select{width:100%;min-height:32px;background:var(--orc-layer1);color:var(--orc-fg);border:1px solid var(--orc-line);border-radius:6px;padding:5px 7px;font:inherit}
.orc-review__check{display:flex;align-items:center;gap:6px;min-height:32px;color:var(--orc-fg2);font-size:12px}
.orc-review__filters button,.orc-review__paging button,.orc-review__modes button,.orc-rgroup__head>button:first-child,.orc-review__empty button{min-height:32px;border:1px solid var(--orc-line);border-radius:6px;background:var(--orc-layer1);color:var(--orc-fg);padding:5px 9px;font:inherit;cursor:pointer}
.orc-review__modes{display:flex;gap:4px}.orc-review__modes [aria-pressed=true]{background:var(--orc-active);border-color:var(--orc-accent)}
.orc-review__layout{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;align-items:start}
.orc-review__layout--detail{grid-template-columns:minmax(0,1fr) minmax(330px,39%)}
.orc-review__list-col{min-width:0}
.orc-review__detail{position:sticky;top:12px;min-width:0;max-height:calc(100vh - 96px);overflow:auto;border:1px solid var(--orc-line);border-radius:10px;background:var(--orc-layer1)}
.orc-review__empty{padding:22px;border:1px dashed var(--orc-line);border-radius:10px;color:var(--orc-fg2)}
.orc-review__empty p{margin:0 0 10px}.orc-review__empty p:last-child{margin:0}
.orc-rlist{margin:0;padding:0;list-style:none;border-top:1px solid var(--orc-line)}
.orc-rrow{position:relative;display:flex;align-items:flex-start;gap:8px;border-bottom:1px solid var(--orc-hair)}
.orc-rrow:hover,.orc-rrow--selected{background:var(--orc-hover)}
.orc-rrow--selected{box-shadow:inset 3px 0 var(--orc-accent)}
.orc-rrow__main{display:grid;gap:3px;flex:1;min-width:0;padding:11px 8px 12px 10px;color:inherit;text-decoration:none}
.orc-rrow__head{display:flex;align-items:center;gap:8px;min-width:0}
.orc-rrow__title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.orc-rrow__head .orc-rstatus{margin-left:auto}
.orc-rrow__meta,.orc-rrow__money{color:var(--orc-fg3);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-rrow__money{white-space:normal}
.orc-rrow__side{display:flex;align-items:center;gap:6px;flex:none;padding:10px 8px 0 0;font-size:11px}
.orc-rstatus{display:inline-flex;align-items:center;gap:5px;flex:none;font-size:11px;font-weight:650;white-space:nowrap}
.orc-rstatus i{display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor}
.orc-rstatus--run{color:var(--orc-accent-strong)}.orc-rstatus--warn{color:var(--orc-warn)}.orc-rstatus--error{color:var(--orc-error)}.orc-rstatus--ok{color:var(--orc-ok)}.orc-rstatus--idle{color:var(--orc-fg3)}
.orc-strip{display:flex;align-items:center;gap:2px;height:12px;margin-top:5px;overflow:hidden}
.orc-strip__cell{flex:1 1 0;min-width:3px;height:9px;padding:0;border:0;border-radius:2px;background:transparent;opacity:.92}
.orc-strip__cell--problem,.orc-strip__cell--steer,.orc-strip__cell--request{height:12px}
.orc-strip--detail{height:18px}.orc-strip--detail .orc-strip__cell{height:14px;cursor:pointer}.orc-strip--detail .orc-strip__cell--problem{height:18px}
.orc-strip--pending{background:linear-gradient(90deg,var(--orc-layer2),transparent);border-radius:2px;height:9px}
.orc-strip__note{display:block;margin-top:3px;color:var(--orc-fg3);font-size:10px;line-height:14px}
.orc-strip__problems{color:var(--orc-error);font-weight:650}
.orc-strip-detail{margin:12px 0 4px}
.orc-strip-legend{display:flex;flex-wrap:wrap;gap:5px 13px;margin:12px 0 0;padding:0;list-style:none;color:var(--orc-fg3);font-size:11px}
.orc-strip-legend i{border-radius:2px}.orc-strip-legend b{color:var(--orc-fg2);font-family:var(--orc-mono)}
.orc-rgroups{display:grid;gap:10px}
.orc-rgroup__head{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px}
.orc-rgroup__head small{color:var(--orc-fg3);font-size:11px}
.orc-review__workers>summary{color:var(--orc-fg2);font-weight:600;cursor:pointer}
.orc-review__workers[open]>summary{margin-bottom:10px}
.orc-review__table{overflow-x:auto;max-width:100%}
.orc-review__table table{width:100%;border-collapse:collapse;font-size:13px;line-height:19px}
.orc-review__table caption{text-align:left;color:var(--orc-fg3);font-size:12px;padding:4px 0}
.orc-review__table th,.orc-review__table td{text-align:left;vertical-align:top;padding:11px 9px;border-bottom:1px solid var(--orc-line);min-width:92px}
.orc-review__table thead th{font-size:12px;color:var(--orc-fg2);font-weight:600;white-space:normal}
.orc-review__table td.orc-num{font-variant-numeric:tabular-nums;text-align:right}
.orc-review__table small{display:block;color:var(--orc-fg3);font-size:12px;margin-top:3px}
.orc-review__link{border:0;background:none;color:var(--orc-accent);padding:0;text-align:left;text-decoration:underline;cursor:pointer;font:inherit}
.orc-review__table .orc-review__title{font-weight:600;color:var(--orc-fg);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.orc-review__account{min-width:180px}.orc-review__account span{display:block;font-size:12px;line-height:18px}
.orc-review__paging{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:9px;margin-top:12px;color:var(--orc-fg2);font-size:12px}
.orc-review__stale{padding:10px 12px;border:1px solid var(--orc-warn);border-radius:7px;color:var(--orc-fg2)}.orc-review__stale button{margin-left:8px;border:0;background:none;color:var(--orc-accent);text-decoration:underline;cursor:pointer}
.orc-review__skeleton{height:100px;border-radius:8px;background:var(--orc-layer1)}
.orc-review__table--tasks td:nth-child(3),.orc-review__table--tasks td:nth-child(4),.orc-review__table--workers td:not(:last-child){font-variant-numeric:tabular-nums;text-align:right}
.orc-drill__comparison td:not(:last-child){font-variant-numeric:tabular-nums;text-align:right}
/* Narrow fallback: one column for progress, time and resources; the band keeps its action. */
@container (max-width:760px){.orc-review__overview,.orc-resources__grid{grid-template-columns:minmax(0,1fr)}.orc-needs{flex-wrap:wrap}.orc-review__search input{min-width:0;width:100%}.orc-rrow{flex-wrap:wrap}.orc-rrow__side{padding:0 10px 10px}}
.orc-drill{flex:0 0 420px;width:420px;min-width:0;height:100%;overflow:auto;padding:16px;border-left:1px solid var(--orc-line);background:var(--orc-layer1);color:var(--orc-fg);font-size:13px}.orc-drill--main{display:block;flex:1;width:100%;height:auto;border-left:0;overflow:visible}.orc-drill--beside{display:block;width:auto;height:auto;border-left:0;overflow:visible;padding:14px}.orc-drill--main{padding:24px 10px}.orc-drill__key{display:flex;flex-wrap:wrap;gap:10px 18px;margin:10px 0 0}.orc-drill__key dd{color:var(--orc-fg);font-weight:600}.orc-drill__more{margin-top:16px}.orc-drill__more>summary{color:var(--orc-fg2);font-weight:600;cursor:pointer}.orc-drill h2{font-size:18px;overflow-wrap:anywhere}.orc-drill h3{font-size:15px;margin:24px 0 10px}.orc-drill__head{display:flex;flex-wrap:wrap;gap:8px}.orc-drill button{cursor:pointer}.orc-drill__head button,.orc-drill__paging button,.orc-drill__modes button{border:1px solid var(--orc-line);border-radius:6px;background:var(--orc-layer2);color:var(--orc-fg);padding:5px 8px}.orc-drill__facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:12px 0}.orc-drill--main .orc-drill__facts{grid-template-columns:repeat(4,minmax(0,1fr))}.orc-drill__facts div,.orc-drill__totals div{padding:8px;border:1px solid var(--orc-line);border-radius:6px;min-width:0}.orc-drill dt{font-size:12px;color:var(--orc-fg2)}.orc-drill dd{margin:4px 0 0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.orc-drill__estimate{color:var(--orc-fg3);font-size:12px}.orc-drill__ledger .orc-ledger__body{height:400px;min-height:260px}.orc-drill:not(.orc-drill--main) .orc-ledger__body{flex-direction:column}.orc-drill:not(.orc-drill--main) .orc-ledger__inspector{width:auto;flex:0 0 180px;border-left:0;border-top:1px solid var(--orc-line)}.orc-drill__modes,.orc-drill__paging{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.orc-drill__modes button[aria-pressed=true]{border-color:var(--orc-fg);font-weight:700}.orc-drill table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}.orc-drill th,.orc-drill td{padding:8px;border:1px solid var(--orc-line);text-align:left;vertical-align:top;overflow-wrap:anywhere}.orc-drill caption{text-align:left;color:var(--orc-fg2);padding:6px}.orc-drill__chart,.orc-drill__comparison{overflow:auto;max-width:100%}.orc-drill__comparison table{min-width:780px}.orc-drill__comparison th:first-child{position:sticky;left:0;min-width:180px;background:var(--orc-layer1)}.orc-drill__comparison td{min-width:260px}.orc-drill__totals{display:flex;gap:8px;flex-wrap:wrap}.orc-drill__totals div{flex:1;min-width:120px}
@media(max-width:1100px){.orc-drill{width:100%;flex:1;border-left:0}.orc-drill__facts,.orc-drill--main .orc-drill__facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
.orc-drill__chart svg{display:block;width:100%;height:90px;margin:10px 0;background:repeating-linear-gradient(to right,var(--orc-line) 0 1px,transparent 1px 10%)}
.orc-chip__compact{display:none}

.orc-preset__edit{border:0;margin:0;padding:0;min-width:0}.orc-run-route p{margin:0}.orc-run-route p+p{margin-top:3px}
.orc-top__spacer{flex:1 1 auto}
.orc-select{min-height:24px;padding:2px 6px;border-radius:6px;border:1px solid var(--orc-line);background:var(--orc-layer2);color:var(--orc-fg);font:inherit}
.orc-top>.orc-select{max-width:150px;flex:0 1 150px;min-width:80px}
.orc-chip{display:inline-flex;align-items:center;gap:5px;min-height:24px;padding:2px 9px;border-radius:999px;border:1px solid transparent;background:var(--orc-layer2);color:var(--orc-fg2);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);cursor:pointer;white-space:nowrap}
.orc-chip:hover{background:var(--orc-hover)}
.orc-chip[aria-pressed="true"]{border-color:currentColor}
/* Красный — это поломка: зависший, упавший, зацикленный воркер. Янтарный носит только «ждёт вас». */
.orc-chip--warn{color:var(--orc-error)}
.orc-chip--review{color:var(--orc-warn)}
.orc-chip--ready{color:var(--orc-accent)}
.orc-chip--running{color:var(--orc-accent-strong)}
/* The acceptance pill with nothing to accept is deliberately quieter than its neighbours. */
.orc-chip--idle{color:var(--orc-fg3)}
.orc-chip:disabled{opacity:.5;cursor:default}
/* Линза: пока она включена, чип и его кнопка «следующая» читаются как один контрол. */
.orc-lens{display:inline-flex;align-items:center;gap:2px}
.orc-lens__go{padding:2px 7px}
.orc-lens--on .orc-lens__go{border-color:currentColor}
.orc-seg{display:flex;gap:2px;padding:2px;border-radius:8px;background:var(--orc-layer2)}
.orc-seg__item{min-height:24px;padding:2px 10px;border:0;border-radius:6px;background:transparent;color:var(--orc-fg3);font:inherit;cursor:pointer}
.orc-seg__item:hover{background:var(--orc-hover);color:var(--orc-fg2)}
.orc-seg__item[aria-checked="true"]{background:var(--orc-layer1);color:var(--orc-fg);box-shadow:var(--dsw-elevation-panel,0 0 0 .5px #fff3)}
.orc-conn{display:inline-flex;align-items:center;gap:5px;color:var(--orc-warn);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}

/* Body: the gutter lives here, not inside each view — both .orc-top and .orc-body pad against the
   same .orc-main width, so header, view and panel share one left and one right edge even while the
   task panel narrows the view. */
/* The centring gutter belongs to the reading views (board, console, timeline): it keeps
   their text off the screen edges. The graph is an infinite canvas — a 160 px band of dead black
   beside the plans rail is just lost space, so it bleeds to the full width. */
.orc-body{display:flex;flex:1 1 auto;min-height:0;position:relative}
.orc-view{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;padding:0 var(--orc-gut)}
.orc-view--bleed{padding:0}

/* Plans rail: flush with the shell's left edge, full height, its own layer. The grid animates the
   column width; inside, the wide list and the badge strip cross-fade — opacity only. */
.orc-plans{position:relative;min-width:0;min-height:0;overflow:hidden;
  border-right:1px solid var(--orc-hair);background:var(--orc-layer1)}
.orc-plans__wide{width:248px;height:100%;display:flex;flex-direction:column;min-height:0;
  background:var(--orc-layer1);transition:opacity 110ms ease}
.orc-plans__slim{position:absolute;top:0;bottom:0;left:0;width:44px;display:flex;flex-direction:column;
  align-items:center;gap:4px;padding:8px 0;
  opacity:0;visibility:hidden;transition:opacity 130ms ease 40ms,visibility 0s 180ms}
.orc-root--rail-shut .orc-plans__wide{opacity:0;visibility:hidden;transition:opacity 110ms ease,visibility 0s 110ms}
.orc-root--rail-shut .orc-plans__slim{opacity:1;visibility:visible;transition:opacity 130ms ease 40ms}
.orc-plans__railbtn{flex:none;width:30px;height:30px;padding:0;border:0;border-radius:8px;
  background:transparent;color:var(--orc-fg3);font-size:16px;line-height:1;cursor:pointer}
.orc-plans__railbtn:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-plans__badges{display:flex;flex-direction:column;align-items:center;gap:5px;flex:1 1 auto;
  min-height:0;width:100%;margin:0;padding:4px 0;list-style:none;overflow-y:auto;scrollbar-width:none}
.orc-plans__badge{position:relative;width:30px;height:30px;padding:0;border:1px solid transparent;
  border-radius:9px;background:var(--orc-layer2);color:var(--orc-fg2);
  font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);font-weight:700;letter-spacing:.02em;cursor:pointer}
.orc-plans__badge:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-plans__badge[aria-current="true"]{background:var(--orc-active);border-color:var(--orc-line);color:var(--orc-fg);
  box-shadow:inset 2px 0 0 var(--orc-accent)}
.orc-plans__dot{position:absolute;top:-3px;right:-3px;width:8px;height:8px;border:2px solid var(--orc-layer1);border-radius:50%}
.orc-plans__dot--warn{background:var(--orc-warn)}
.orc-plans__dot--error{background:var(--orc-error)}
.orc-plans__dot--run{background:var(--orc-accent-strong)}
.orc-plans__head{display:flex;align-items:center;gap:6px;padding:9px 12px 3px}
.orc-plans__title{flex:1 1 auto;min-width:0;margin:0;color:var(--orc-fg2);
  font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);text-transform:uppercase;letter-spacing:.03em}
.orc-plans__hide{flex:none;min-width:24px;min-height:24px;padding:0;border:0;border-radius:6px;
  background:transparent;color:var(--orc-fg3);font-size:15px;line-height:1;cursor:pointer}
.orc-plans__hide:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-plans__composer{padding:6px 8px 2px}
.orc-plans__field{width:100%;min-height:28px;padding:4px 8px;border:1px solid var(--orc-line);border-radius:7px;
  background:var(--orc-layer2);color:var(--orc-fg);font:inherit}
.orc-plans__error{margin:2px 10px 0}
/* The repository sidebar: search, the cross-repo «Needs you» inbox, then the tree. Quiet by
   default — counters and colour appear only where something asks for a person. */
.orc-plans__inboxdot{flex:none;min-width:24px;height:22px;padding:0 6px;border:0;border-radius:11px;
  background:var(--orc-warn);color:#fff;font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);font-weight:700;cursor:pointer}
.orc-side__searchbox{position:relative;flex:none;padding:8px 12px 2px}
.orc-side__search{width:100%;min-height:26px;padding:3px 36px 3px 8px;border:1px solid var(--orc-line);border-radius:7px;
  background:var(--orc-layer2);color:var(--orc-fg);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}
.orc-side__kbd{position:absolute;right:18px;top:11px;padding:0 4px;border:1px solid var(--orc-hair);border-radius:4px;
  color:var(--orc-fg3);font:10px/14px var(--orc-mono);pointer-events:none}
.orc-side__hits{margin:2px 0 0;padding:0 12px;list-style:none}
.orc-side__empty{padding:4px 12px 6px;color:var(--orc-fg3);font-size:12px;list-style:none}
.orc-ghit__row{display:flex;align-items:baseline;gap:6px;width:100%;min-width:0;min-height:24px;padding:3px 6px;
  border:0;border-radius:6px;background:transparent;color:var(--orc-fg2);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.orc-ghit__row:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-ghit__row--active{background:var(--orc-active);color:var(--orc-fg)}
.orc-ghit__kind{flex:none;width:12px;color:var(--orc-fg3);text-align:center}
.orc-ghit__label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-ghit__hint{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--orc-fg3);font-size:11px}
.orc-side__head{display:flex;align-items:center;gap:6px;margin:12px 12px 2px;color:var(--orc-fg3);
  font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.orc-side__add{margin-left:auto;min-width:20px;min-height:18px;padding:0 5px;border:0;border-radius:5px;
  background:transparent;color:var(--orc-fg3);font-size:13px;line-height:1;cursor:pointer}
.orc-side__add:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-side__calm{margin:2px 12px 0;color:var(--orc-fg3);font-size:12px}
.orc-inbox{flex:none}
.orc-inbox__list{max-height:34vh;overflow:auto;margin:0;padding:0 12px;list-style:none}
.orc-ibrow{display:flex;align-items:center;gap:6px;width:100%;min-width:0;height:32px;padding:0 8px;
  border:1px solid transparent;border-radius:8px;
  background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.orc-ibrow:hover{background:var(--orc-hover)}
.orc-ibrow__line{flex:1 1 auto;min-width:0;color:var(--orc-fg2);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-ibrow__id{color:var(--orc-fg3);font-family:var(--orc-mono);font-size:11px}
.orc-ibrow__meta{flex:0 1 auto;min-width:0;color:var(--orc-fg3);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-ibrow--alert .orc-ibrow__meta{color:var(--orc-error)}
.orc-ibrow--example{border-style:dashed;border-color:var(--orc-line)}
.orc-inbox__divider{display:flex;align-items:center;gap:6px;margin:6px 0 2px;padding:0 8px;color:var(--orc-fg3);font-size:11px}
.orc-inbox__divider::after{content:'';flex:1 1 auto;border-top:1px solid var(--orc-line)}
.orc-tree{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.orc-tree__list{flex:1 1 auto;min-height:0;overflow:auto;margin:0;padding:0 12px 10px;list-style:none}
.orc-tree__list ul{margin:0;padding:0;list-style:none}
/* Tree rows borrow the Workspaces cell geometry: 8px side padding, 8px radius, a 16px leading
   slot, one 6px gap. Repository rows stand 34px, plan rows 32px. The count and the row menu are
   overlays — they keep their space out of the flow so the name runs to the status mark, and their
   chip paint is layer-1 composited with the row's own tint, so a hovered or selected row never
   shows a mismatched patch. */
.orc-srow{position:relative;display:flex;align-items:center;gap:2px}
.orc-srow__main{position:relative;flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px;
  height:32px;padding:0 8px;border:1px solid transparent;border-radius:8px;
  background:transparent;color:var(--orc-fg2);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.orc-srow__main:hover{background:var(--orc-hover)}
.orc-srow__main[aria-current="true"]{background:var(--orc-active);border-color:var(--orc-line);box-shadow:inset 2px 0 0 var(--orc-accent)}
.orc-srow__main--repo{height:34px;color:var(--orc-fg);font-size:14px}
.orc-srow__slot{flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;color:var(--orc-fg3)}
.orc-srow__glyph--active{color:var(--orc-accent-strong)}
/* Folder by default, expand arrow in its place on row hover or keyboard focus — the same swap the
   Workspaces row makes. Both slots keep 16px, so the title never shifts. */
.orc-srow__chev{display:none;color:var(--orc-fg3)}
.orc-srow__main:hover .orc-srow__chev,.orc-srow__main:focus-visible .orc-srow__chev{display:inline-flex}
.orc-srow__main:hover .orc-srow__glyph,.orc-srow__main:focus-visible .orc-srow__glyph{display:none}
.orc-srow__arrow{transition:transform 150ms ease}
.orc-srow__arrow--open{transform:rotate(90deg)}
.orc-srow__name{flex:1 1 auto;min-width:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-srow__example{color:var(--orc-fg3);font-weight:400}
.orc-srow__meta{flex:none;color:var(--orc-fg3);font-size:11px;white-space:nowrap}
/* Numbers stay muted and surface only while the row is hovered or focused. */
.orc-srow__peek{position:absolute;right:30px;top:50%;translate:0 -50%;z-index:1;padding:1px 5px;
  border-radius:5px;background:var(--orc-layer1);opacity:0;transition:opacity 120ms ease;pointer-events:none}
.orc-srow:hover .orc-srow__peek,.orc-srow__main:focus-visible .orc-srow__peek{opacity:1}
.orc-srow:hover .orc-srow__peek{background:linear-gradient(var(--orc-hover),var(--orc-hover)) var(--orc-layer1)}
.orc-srow__main[aria-current="true"] .orc-srow__peek{background:linear-gradient(var(--orc-active),var(--orc-active)) var(--orc-layer1)}
.orc-srow__state{flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center}
/* The status dot speaks the shell's StateDot language: a 10% halo ring over a solid core, and the
   8-cell pixel chase for running work. */
.orc-sdot{position:relative;display:inline-block;flex:none;width:10px;height:10px}
.orc-sdot::before{content:'';position:absolute;inset:0;border-radius:50%;background:currentColor;opacity:.1}
.orc-sdot::after{content:'';position:absolute;inset:20%;border-radius:50%;background:currentColor}
.orc-sdot--waiting{color:var(--orc-warn)}
.orc-sdot--failed{color:var(--orc-error)}
.orc-sdot--running{color:var(--orc-accent-strong)}
.orc-sdot-matrix{flex:none;color:var(--orc-accent-strong)}
.orc-sdot-matrix rect{fill:currentColor;animation:orc-sdot-chase 1s infinite}
@keyframes orc-sdot-chase{
  0%,12.4%{opacity:1}
  12.5%,24.9%{opacity:.6}
  25%,37.4%{opacity:.35}
  37.5%,100%{opacity:.15}
}
.orc-srow__fold{color:var(--orc-fg3)}
.orc-srow__fold--dim{color:var(--orc-fg3)}
.orc-srow--arch .orc-srow__name{color:var(--orc-fg3)}
.orc-srow__kids{margin:0;padding:0;list-style:none}
.orc-srow__grouphead{display:block;padding:4px 0 1px 30px;color:var(--orc-fg3);font-size:10px;font-weight:600;
  text-transform:uppercase;letter-spacing:.05em}
/* The open plan's lane tree (nv1): a third level styled like a file tree — a disclosure triangle on
   the two group rows, an indent guide down the lanes, rows as tall as every other sidebar row. */
.orc-tree__list .orc-lanetree{padding-left:22px}
.orc-srow__lanegroup{height:28px;color:var(--orc-fg3);font-size:12px}
.orc-srow__lanegroup--past .orc-srow__name{color:var(--orc-fg3)}
.orc-lanegroup__arrow{flex:none;width:10px;font-size:8px;line-height:1;color:var(--orc-fg3);transition:transform 150ms ease}
.orc-lanegroup__arrow--open{transform:rotate(90deg)}
.orc-tree__list .orc-lanes{margin:0 0 0 12px;padding:0 0 0 6px;border-left:1px solid var(--orc-line)}
.orc-srow__main--lane{gap:8px;color:var(--orc-fg2)}
.orc-srow__main--past{color:var(--orc-fg3)}
.orc-srow__main--inview{background:var(--orc-active);border-color:var(--orc-line)}
.orc-lanedot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--orc-fg3);opacity:.7}
.orc-lanedot--waiting{background:var(--orc-warn);opacity:1}
.orc-lanedot--running{background:var(--orc-accent-strong);opacity:1}
.orc-lanecounts{flex:none;display:inline-flex;gap:6px;color:var(--orc-fg3);font-size:11px;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.orc-lanecount--running{color:var(--orc-accent-strong)}
.orc-lanecount--review{color:var(--orc-warn)}
.orc-lanecount--ready{color:var(--orc-accent)}
.orc-lanecount--queued,.orc-lanecount--accepted{color:var(--orc-fg3)}
/* The ⋯ button steps into the status slot on hover or focus — the same slot swap as the
   folder/arrow affordance. */
.orc-srow__menu{position:absolute;right:4px;top:50%;translate:0 -50%;z-index:2;width:24px;height:24px;padding:0;
  border:0;border-radius:6px;display:grid;place-items:center;background:var(--orc-layer1);color:var(--orc-fg3);
  line-height:1;cursor:pointer;opacity:0}
.orc-srow:hover .orc-srow__menu,.orc-srow__main:focus-visible+.orc-srow__menu,.orc-srow__menu:focus-visible{opacity:1}
.orc-srow:hover .orc-srow__menu{background:linear-gradient(var(--orc-hover),var(--orc-hover)) var(--orc-layer1)}
.orc-srow__menu:hover{color:var(--orc-fg);background:linear-gradient(var(--orc-active),var(--orc-active)) var(--orc-layer1)}
.orc-srow__main[aria-current="true"]+.orc-srow__menu{background:linear-gradient(var(--orc-active),var(--orc-active)) var(--orc-layer1)}
.orc-srow--edit{flex:1 1 auto;padding:3px 0}
.orc-smenu{position:fixed;z-index:40;display:flex;flex-direction:column;min-width:180px;margin:0;padding:4px;
  list-style:none;border:1px solid var(--orc-line);border-radius:9px;background:var(--orc-layer2);
  box-shadow:0 8px 24px #00000059;animation:orc-sheet-in 140ms cubic-bezier(.23,1,.32,1) both;transform-origin:top left}
.orc-smenu .orc-link{min-height:26px}
.orc-smenu .orc-link:disabled{opacity:.45;cursor:default}
.orc-smenu .orc-link:disabled:hover{background:transparent}
.orc-smenu__item--danger{color:var(--orc-error)}
/* A menu item can carry one quiet line under its label: what it will (or why it cannot) do. A
   disabled item keeps that reason readable — only its label dims. */
.orc-smenu__hint{display:block;color:var(--orc-fg3);font-size:11px;line-height:15px;max-width:280px}
.orc-smenu .orc-link.orc-smenu__item--why:disabled{opacity:1;color:var(--orc-fg3)}
/* The drop affordance borrows the Workspaces insert marker: a 2px rule with a leading chevron
   between rows, absolutely positioned so it neither resembles a row border nor shifts layout. */
.orc-srow--dropBefore,.orc-srow--dropAfter{position:relative}
.orc-srow--dropBefore::before,.orc-srow--dropAfter::after{content:'';position:absolute;z-index:3;left:0;right:4px;height:12px;
  background:
    linear-gradient(55deg,transparent calc(50% - 1px),var(--orc-accent-strong) calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)) 0 0/5px 7px no-repeat,
    linear-gradient(125deg,transparent calc(50% - 1px),var(--orc-accent-strong) calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)) 0 5px/5px 7px no-repeat,
    linear-gradient(var(--orc-accent-strong) 0 0) 4px 5px/calc(100% - 4px) 2px no-repeat;
  pointer-events:none}
.orc-srow--dropBefore::before{top:-7px}
.orc-srow--dropAfter::after{bottom:-7px}
/* The grabbed row stays in place, dimmed; a fixed-position copy carries its name to the pointer. */
.orc-srow--lift{opacity:.45}
.orc-plans--drag{user-select:none}
.orc-plans--drag .orc-srow{cursor:grabbing}
.orc-sdrag{position:fixed;z-index:50;display:flex;align-items:center;height:32px;padding:0 10px;
  border:1px solid var(--orc-line);border-radius:8px;background:var(--orc-layer2);color:var(--orc-fg);
  font-size:13px;box-shadow:0 8px 24px #00000059;pointer-events:none}
.orc-sdrag__name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-side__gear{flex:none;min-width:20px;min-height:18px;padding:0 4px;border:0;border-radius:5px;
  background:transparent;color:var(--orc-fg3);line-height:1;cursor:pointer;display:grid;place-items:center}
.orc-side__gear:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-side__toast{position:absolute;bottom:10px;left:10px;z-index:5;margin:0;padding:3px 10px;border:1px solid var(--orc-line);
  border-radius:7px;background:var(--orc-layer2);color:var(--orc-fg2);font-size:11px}
/* Header breadcrumb: repository / plan. */
.orc-crumb{display:inline-flex;align-items:center;gap:4px;min-width:0;flex:0 1 auto}
.orc-crumb__repo{max-width:20ch;padding:2px 6px;border:0;border-radius:6px;background:transparent;color:var(--orc-fg);
  font:var(--dsw-font-strong-xs-13,600 13px/20px system-ui,sans-serif);font-weight:600;cursor:pointer;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-crumb__repo:hover{background:var(--orc-hover)}
.orc-crumb__sep{color:var(--orc-fg3)}
/* Status chips open an anchored list; the lens stays a lens, the list is its table of contents. */
.orc-lenschip{position:relative;display:inline-flex;flex:none}
.orc-lenspop{position:absolute;top:calc(100% + 4px);right:0;z-index:35;width:288px;max-height:330px;display:flex;flex-direction:column;
  border:1px solid var(--orc-line);border-radius:10px;background:var(--orc-layer1);
  box-shadow:0 10px 30px #00000066;animation:orc-sheet-in 140ms cubic-bezier(.23,1,.32,1) both;transform-origin:top right}
.orc-lenspop__list{flex:1 1 auto;min-height:0;overflow:auto;margin:0;padding:4px;list-style:none}
.orc-lensrow{display:block;width:100%;min-width:0;padding:3px 8px;border:0;border-radius:7px;
  background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.orc-lensrow:hover,.orc-lensrow--active{background:var(--orc-hover)}
.orc-lensrow__line{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-lensrow__line b{color:var(--orc-fg3);font-weight:600;font-family:var(--orc-mono);font-size:11px}
.orc-lensrow__meta{display:block;color:var(--orc-fg3);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-lensrow--alert .orc-lensrow__meta{color:var(--orc-error)}
.orc-lenspop__hint{flex:none;margin:0;padding:5px 10px;border-top:1px solid var(--orc-hair);color:var(--orc-fg3);font-size:11px}
.orc-copyagent{flex:none;min-height:22px;padding:1px 8px;border:1px solid var(--orc-line);border-radius:6px;
  background:transparent;color:var(--orc-fg3);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);cursor:pointer}
.orc-copyagent:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-copyagent--icon{min-width:24px;padding:1px 5px}
/* Draft review uses the same reading width and text density as the task detail. */
.orc-draft{max-width:960px;margin:0 auto;padding:24px 20px 48px;color:var(--orc-fg2)}
.orc-draft__head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding-bottom:18px;border-bottom:1px solid var(--orc-line)}
.orc-draft__head>div{flex:1 1 auto;min-width:0}
.orc-draft__head>.orc-link{flex:none;width:auto;padding:4px 10px;border:1px solid var(--orc-line);background:var(--orc-layer2);color:var(--orc-fg)}
.orc-draft__eyebrow{color:var(--orc-fg3);font-size:12px}
.orc-draft h1{margin:4px 0;font-size:22px;line-height:30px;color:var(--orc-fg);font-weight:650}
.orc-draft h2{margin:0 0 10px;color:var(--orc-fg);font-size:14px;line-height:20px;font-weight:650}
.orc-draft__head p{margin:0;color:var(--orc-fg3);font-size:12px}
.orc-draft__findings,.orc-draft__decisions{padding:18px 0;border-bottom:1px solid var(--orc-hair)}
.orc-draft__findings ul,.orc-draft__decisions ul{margin:0;padding-left:20px}
.orc-draft__findings li{margin:5px 0;color:var(--orc-fg3)}
.orc-draft__findings .orc-draft__finding--block{color:var(--orc-error)}
.orc-draft__links{display:inline-flex;gap:7px;margin-left:9px}
.orc-draft a{color:var(--orc-accent)}
.orc-draft__lanes{display:grid;gap:20px;padding:20px 0}
.orc-draft__lanes>section>ol{display:grid;gap:8px;margin:0;padding:0;list-style:none}
.orc-draft__task{padding:13px 15px;border:1px solid var(--orc-line);border-radius:8px;background:var(--orc-layer1);scroll-margin-top:12px}
.orc-draft__task:target{border-color:var(--orc-accent)}
.orc-draft__task-head{display:flex;justify-content:space-between;gap:12px;color:var(--orc-fg)}
.orc-draft__task-head span,.orc-draft__identity{color:var(--orc-fg3);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}
.orc-draft__identity{margin:3px 0 10px}
.orc-draft__task dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:0;font-size:12px}
.orc-draft__task dt{color:var(--orc-fg3)}
.orc-draft__task dd{margin:0;overflow-wrap:anywhere}
.orc-draft__task dd ul{margin:0;padding-left:16px}
.orc-draft__task details{margin-top:12px;padding-top:8px;border-top:1px solid var(--orc-hair)}
.orc-draft__task summary{cursor:pointer;color:var(--orc-fg2);font-size:12px}
.orc-draft__task pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/18px var(--orc-mono)}
.orc-draft__answer{max-height:420px;overflow:auto;margin:8px 0 0;padding:10px 12px;border:1px solid var(--orc-line);border-radius:8px;background:var(--orc-layer1);white-space:pre-wrap;overflow-wrap:anywhere;font:12px/18px var(--orc-mono)}
.orc-draft__decisions summary{cursor:pointer;color:var(--orc-fg);font-weight:650}
.orc-draft__actions{position:sticky;bottom:0;z-index:1;display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:0 -20px;padding:12px 20px;border-top:1px solid var(--orc-line);background:var(--orc-bg)}
.orc-draft__actions>.orc-link{width:auto;margin-left:auto;color:var(--orc-fg3)}
.orc-draft__actions>.orc-link:hover{color:var(--orc-error)}
.orc-draft__approve{padding:6px 12px;border:1px solid var(--orc-accent-strong);border-radius:7px;background:var(--orc-accent-strong);color:#fff;font:inherit;cursor:pointer}
.orc-draft__approve:disabled{opacity:.45;cursor:default}
.orc-draft__reason{color:var(--orc-error);font-size:12px}
.orc-draft__confirm{display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px;color:var(--orc-fg2)}
.orc-draft__confirm button{padding:4px 8px;border:1px solid var(--orc-line);border-radius:6px;background:var(--orc-layer2);color:var(--orc-fg);font:inherit;cursor:pointer}
/* ≤1100px: the rail keeps its 44px strip and the open list slides over main instead of pushing it. */
@media (max-width:1100px){
  .orc-root{--orc-rail-w:44px;transition:none}
  .orc-plans__slim{opacity:1;visibility:visible;transition:none}
  .orc-root--rail-open .orc-plans{overflow:visible}
  .orc-root--rail-open .orc-plans__wide{position:absolute;top:0;bottom:0;left:100%;z-index:20;width:min(280px,86vw);
    border-right:1px solid var(--orc-line);box-shadow:0 10px 34px #00000080;
    animation:orc-rail-in 160ms cubic-bezier(.23,1,.32,1) both}
}
@keyframes orc-rail-in{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:none}}
/* Container width is the space left after the plans rail, not the browser width. */
@container (max-width:1100px){.orc-chip--running .orc-chip__label,.orc-chip--ready .orc-chip__label{display:none}.orc-chip__compact{display:inline}}
@container (max-width:1400px){
  .orc-top>.orc-select{max-width:110px;flex-basis:110px}
  .orc-goal{max-width:100px;min-width:0}
  .orc-preset__trigger{max-width:150px}
  .orc-view-menu .orc-select{max-width:90px}
}
@container (max-width:1100px){.orc-top>.orc-seg{display:none}.orc-view-menu{display:block}}
@container (max-width:900px){
  .orc-top>.orc-select{max-width:72px;min-width:0;flex-basis:72px}
  .orc-goal{max-width:65px}
  .orc-preset__trigger{max-width:120px}
  .orc-view-menu .orc-select{max-width:78px}
}


/* The task panel and the acceptance queue are chrome: they sit on the screen edge, while the
   centring gutter now lives inside .orc-view and never pushes them around. */
.orc-panel,.orc-queue{flex:0 0 360px;width:360px;min-width:0;display:flex;flex-direction:column;border-left:1px solid var(--orc-hair);background:var(--orc-layer1);overflow:hidden}
@media (max-width:1100px){
  .orc-body{flex-direction:column}
  .orc-panel,.orc-queue{flex:0 0 auto;width:auto;max-height:48%;border-left:0;border-top:1px solid var(--orc-hair)}
  .orc-sec,.orc-tabpanel{max-width:760px}
}
.orc-empty{padding:22px var(--orc-gut);color:var(--orc-fg3);max-width:calc(60ch + 2 * var(--orc-gut))}
/* Inside .orc-view the gutter is already spent by .orc-body; a second one would double it. */
.orc-view .orc-empty{padding-right:0;padding-left:0;max-width:60ch}

/* Board: the columns share the width instead of owning a slice of it, so the plan spreads across the
   window and each card gets room for its title instead of breaking it over two cramped lines. */
.orc-board{display:grid;grid-template-columns:repeat(auto-fit,minmax(248px,1fr));gap:12px;align-items:start;padding:14px 0 22px}
.orc-col{min-width:0;border:1px solid var(--orc-hair);border-radius:10px;background:var(--orc-layer1);padding:8px}
.orc-col--muted{opacity:.72}
.orc-col__head{display:flex;align-items:baseline;gap:6px;padding:2px 4px 6px;color:var(--orc-fg2);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);text-transform:uppercase;letter-spacing:.03em}
.orc-col__count{color:var(--orc-fg3);font-variant-numeric:tabular-nums}
.orc-cards{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.orc-card{display:block;width:100%;text-align:left;padding:7px 9px;border:1px solid var(--orc-hair);border-radius:8px;background:var(--orc-layer2);color:inherit;font:inherit;cursor:pointer}
.orc-card:hover{background:var(--orc-hover)}
.orc-card[aria-pressed="true"]{border-color:var(--orc-accent);box-shadow:0 0 0 1px var(--orc-accent)}
.orc-card--dim{opacity:.62}
.orc-card__top{display:flex;align-items:baseline;gap:6px}
.orc-glyph{flex:none;width:14px;text-align:center}
.orc-card__id{color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);font-variant-numeric:tabular-nums}
.orc-card__title{flex:1 1 auto;min-width:0;font-weight:600;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.orc-card__identity,.orc-panel__identity{display:flex;align-items:center;gap:5px;min-width:0;margin-top:3px;color:var(--orc-fg2);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.orc-panel__identity{margin-top:5px;font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}
.orc-prov--img{object-fit:contain;background:transparent;padding:1px}
.orc-prov{display:inline-flex;flex:none;align-items:center;justify-content:center;width:19px;height:18px;border-radius:5px;background:color-mix(in srgb,currentColor 16%,var(--orc-layer2));color:var(--orc-fg2);font:700 9px/1 system-ui,sans-serif;letter-spacing:.01em}
.orc-prov--DS{color:var(--orc-prov-deepseek)}
.orc-prov--CL{color:var(--orc-prov-claude)}
.orc-prov--CX{color:var(--orc-prov-codex)}
.orc-prov--DV{color:var(--orc-prov-devin)}
.orc-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.orc-meta{display:block;margin-top:2px;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.orc-meta--warn{color:var(--orc-warn)}
.orc-meta--alert{color:var(--orc-error)}

/* Console: one track on a narrow window, two on a wide one — what is broken leads on the left, what
   is moving and what could start stack on the right. The totals close the screen across both. */
.orc-console{display:grid;grid-template-columns:minmax(0,1fr);align-content:start;gap:12px;padding:14px 0 22px}
.orc-console__col{display:flex;flex-direction:column;gap:12px;min-width:0}
.orc-console__tally .orc-facts{margin-top:0}
/* 1400px, not 1200: the task panel can take 360px off the view, and two 400px tracks read worse
   than one wide one. A container query would trap the fixed batch sheet, so the window decides. */
@media (min-width:1400px){
  .orc-console{grid-template-columns:minmax(0,1.08fr) minmax(0,1fr)}
  .orc-console__tally{grid-column:1 / -1}
}
.orc-block{border:1px solid var(--orc-hair);border-radius:10px;background:var(--orc-layer1);padding:10px 12px}
.orc-block__head{display:flex;align-items:baseline;gap:6px;margin-bottom:6px;color:var(--orc-fg2);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);text-transform:uppercase;letter-spacing:.03em}
.orc-rows{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.orc-row{display:flex;align-items:center;gap:8px;padding:6px 6px;border-radius:8px;transition:opacity 160ms ease-out}
.orc-cards>li{transition:opacity 160ms ease-out}
/* Линза на доске и в консоли: строка остаётся на месте и кликабельна — только уходит в полупрозрачность. */
.orc-lens-dim{opacity:.45}
.orc-row+.orc-row{border-top:1px solid var(--orc-sep)}
.orc-row__main{flex:1 1 auto;min-width:0;display:block;text-align:left;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:0}
.orc-row__main:hover .orc-card__title{text-decoration:underline}

/* Batch acceptance: the trigger sits in a head, the sheet is a popover fixed to the viewport so no
   scrolling ancestor can clip it. One confirmation covers the whole list — the picking happens here. */
.orc-col__bar{display:flex;align-items:center;gap:6px}
.orc-col__bar>:first-child{flex:1 1 auto;min-width:0}
.orc-col__bar .orc-block__head{flex:0 1 auto;margin-bottom:0}
.orc-block>.orc-col__bar{margin-bottom:6px}
.orc-batch{min-height:22px;padding:1px 8px;white-space:nowrap;font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);font-weight:500;text-transform:none;letter-spacing:0}
/* Columns are wide enough for the head and the action to share a line; wrap only if a narrow
   window squeezes one below its share. */
.orc-col .orc-col__bar{flex-wrap:wrap}
.orc-col .orc-batch{margin:2px 0 4px}
.orc-sheet{position:fixed;z-index:30;display:flex;flex-direction:column;width:340px;max-width:calc(100vw - 16px);
  border:1px solid var(--orc-line);border-radius:12px;background:var(--orc-layer1);box-shadow:0 10px 30px #00000066;
  animation:orc-sheet-in 140ms cubic-bezier(.23,1,.32,1) both}
@keyframes orc-sheet-in{from{opacity:0;transform:translateY(-4px) scale(.985)}to{opacity:1;transform:none}}
.orc-sheet__head{display:flex;align-items:center;gap:8px;padding:8px 12px 6px;color:var(--orc-fg2);
  font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);text-transform:uppercase;letter-spacing:.03em}
.orc-sheet__list{flex:1 1 auto;min-height:0;overflow:auto;margin:0;padding:0 6px;overscroll-behavior:contain}
.orc-sheet__item{display:flex;align-items:flex-start;gap:8px;padding:5px 6px;border-radius:8px}
.orc-sheet__item:hover{background:var(--orc-hover)}
.orc-sheet__item+.orc-sheet__item{border-top:1px solid var(--orc-sep)}
.orc-check{flex:none;width:14px;height:14px;margin:3px 0 0;accent-color:var(--orc-accent-strong);cursor:pointer}
.orc-sheet__label{flex:1 1 auto;min-width:0;cursor:pointer}
.orc-sheet__kind{display:inline-block;width:12px;margin-right:4px;color:var(--orc-fg2)}
.orc-sheet__open{flex:none;min-height:22px;padding:1px 5px;border:0;border-radius:6px;background:transparent;color:var(--orc-fg3);
  font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);cursor:pointer}
.orc-sheet__open:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-sheet__foot{padding:8px 12px 10px;border-top:1px solid var(--orc-hair)}
.orc-sheet__rows{margin:0;padding:0;list-style:none}
.orc-sheet__group{margin:6px 6px 2px;color:var(--orc-fg2);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);text-transform:uppercase;letter-spacing:.03em}
.orc-sheet__group-hint{margin:0 6px 4px}
.orc-sheet__risk{color:var(--orc-warn)}
.orc-sheet__foot .orc-actions{margin-top:0}

/* Task panel */
.orc-panel__scroll{flex:1 1 auto;min-height:0;overflow:auto}
.orc-panel__fixed{flex:none;max-height:55%;overflow:auto;background:var(--orc-layer1);border-bottom:1px solid var(--orc-line)}
.orc-panel__fixed .orc-sec:last-child{border-bottom:0}
.orc-sec--head{padding-bottom:7px}
.orc-sec--actions{padding-top:7px;padding-bottom:9px}
.orc-sec--actions .orc-actions{margin-top:0}
.orc-sec{padding:10px 14px;border-bottom:1px solid var(--orc-hair)}
.orc-h{font:var(--dsw-font-l-20,500 20px/28px system-ui,sans-serif);font-size:15px;line-height:21px;font-weight:600;letter-spacing:-.01em}
.orc-sub{margin-top:2px;color:var(--orc-fg3);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}
.orc-now{border:1px solid var(--orc-line);border-radius:8px;background:var(--orc-layer2);padding:8px 10px;color:var(--orc-fg2)}
.orc-now--warn{border-color:var(--orc-warn);color:var(--orc-fg)}
.orc-now--alert{border-color:var(--orc-error);color:var(--orc-fg)}
.orc-now small{display:block;margin-top:3px;color:var(--orc-fg3)}
.orc-path{display:inline-block;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.orc-run__link{padding:0 2px;border:0;border-radius:5px;background:transparent;color:var(--orc-accent);font:inherit;cursor:pointer}
.orc-run__link:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}
.orc-panel .orc-actions{flex-wrap:nowrap;min-width:0}
.orc-panel .orc-actions>.orc-btn,.orc-panel .orc-actions>.orc-select{min-width:0;white-space:nowrap}
.orc-panel .orc-actions>.orc-select{flex:1 1 auto;max-width:100%}
.orc-btn{min-height:24px;padding:4px 11px;border-radius:7px;border:1px solid transparent;background:var(--orc-fg);color:var(--orc-bg);font:inherit;font-weight:600;cursor:pointer}
.orc-btn:hover{opacity:.9}
.orc-btn:disabled{opacity:.5;cursor:default}
.orc-btn--ghost{background:var(--orc-layer2);color:var(--orc-fg2);border-color:var(--orc-line);font-weight:500}
.orc-btn--ghost:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-hint{margin-top:6px;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif)}
.orc-merge__commands{margin:6px 0 4px;padding:6px 8px;border:1px solid var(--orc-line);border-radius:6px;background:var(--orc-layer1);color:var(--orc-fg2);font:11px/16px var(--orc-mono);white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
.orc-error{margin-top:6px;color:var(--orc-error);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}
.orc-form{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.orc-field{width:100%;min-height:52px;padding:6px 8px;border:1px solid var(--orc-line);border-radius:8px;background:var(--orc-layer2);color:var(--orc-fg);font:inherit;resize:vertical}
/* A decision is a reading and checking surface. Keep it in the panel's existing neutral palette. */
.orc-decision__heading{margin:0 0 7px;color:var(--orc-fg);font:var(--dsw-font-xs-13,13px/20px system-ui,sans-serif);font-weight:600}
.orc-decision__source{margin-bottom:8px;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);overflow-wrap:anywhere}
.orc-decision__content{display:flex;flex-direction:column;gap:5px}
.orc-decision__text{margin:0;color:var(--orc-fg2);font:var(--dsw-font-xs-13,13px/20px system-ui,sans-serif);white-space:pre-wrap;overflow-wrap:anywhere}
.orc-decision__check{display:flex;align-items:flex-start;gap:8px;min-height:24px;color:var(--orc-fg);font:var(--dsw-font-xs-13,13px/20px system-ui,sans-serif);cursor:pointer}
.orc-decision__check input{flex:none;width:15px;height:15px;margin:2px 0 0;accent-color:var(--orc-accent-strong);cursor:pointer}
.orc-decision__check input:focus-visible,.orc-decision__link:focus-visible{outline:2px solid var(--orc-accent);outline-offset:2px}
.orc-decision__total{margin:0 0 6px;color:var(--orc-fg2);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}
.orc-decision__deps{margin:0;padding:0;list-style:none}
.orc-decision__deps li{padding:6px 0;border-top:1px solid var(--orc-sep)}
.orc-decision__link{display:flex;align-items:baseline;gap:7px;width:100%;padding:2px 3px;border:0;border-radius:5px;background:transparent;color:var(--orc-fg);font:inherit;text-align:left;cursor:pointer}
.orc-decision__link:hover{background:var(--orc-hover)}
.orc-decision__mark{flex:none;width:12px;color:var(--orc-fg2);font-weight:600;text-align:center}
.orc-decision__dep-title{overflow-wrap:anywhere}
.orc-decision__dep-meta{display:block;margin:2px 0 0 22px;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif)}
.orc-decision__action-help{margin-top:8px;color:var(--orc-fg2);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif)}
.orc-decision__action-help .orc-decision__heading{margin-bottom:2px;font-size:12px;line-height:18px}
.orc-decision__action-help p{margin:2px 0}
.orc-drill__sub{margin:-4px 0 10px;color:var(--orc-fg3);font-size:12px}
.orc-steers{display:grid;gap:8px}.orc-steer{padding:8px 10px;border:1px solid var(--orc-hair);border-radius:7px}.orc-steer__text{margin:0;color:var(--orc-fg);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.orc-steer__meta{margin:4px 0 0;color:var(--orc-fg3);font-size:11px}.orc-steer__recovery{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin-top:8px;color:var(--orc-fg2);font-size:12px}
.orc-tabs{display:flex;flex-wrap:nowrap;gap:6px;padding:6px 8px 0;border-bottom:1px solid var(--orc-hair)}
.orc-tab{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-height:24px;padding:4px 2px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--orc-fg3);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);cursor:pointer;text-align:center}
.orc-tab:nth-child(1),.orc-tab:nth-child(2){flex-grow:1.2}
.orc-tab:hover{color:var(--orc-fg2)}
.orc-tab[aria-selected="true"]{color:var(--orc-fg);border-bottom-color:var(--orc-fg)}
.orc-tabpanel{padding:8px 14px}
.orc-tabpanel>.orc-sec{padding:8px 0}
.orc-overview-section{padding:10px 0;border-top:1px solid var(--orc-hair)}
.orc-overview-section h3{margin:0 0 6px;font-size:12px}
.orc-relation-list{display:flex;flex-wrap:wrap;gap:5px;list-style:none;margin:4px 0;padding:0}
.orc-relation-chip,.orc-panel__chip{display:inline-block;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--orc-line);border-radius:999px;background:var(--orc-layer2);padding:1px 7px;color:var(--orc-fg2);font:var(--dsw-font-xxxs-11,11px/17px system-ui,sans-serif)}
.orc-relation-chip{cursor:pointer}
.orc-panel__chips{display:flex;align-items:center;gap:4px;overflow:hidden;margin-top:5px}
.orc-panel__chip{flex:none;max-width:70px}
.orc-panel__identity-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-panel__identity>span:not(.orc-panel__identity-name){flex:none}
.orc-panel__worktree{display:grid;grid-template-columns:minmax(0,1fr) 20px minmax(0,.7fr) 20px;align-items:center;gap:2px;min-width:0;margin-top:5px;color:var(--orc-fg3)}
.orc-panel__worktree code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px var(--orc-mono);color:var(--orc-fg2)}
.orc-panel__worktree button{border:0;background:transparent;color:var(--orc-fg3);cursor:pointer}
.orc-panel__baseline{grid-column:1/-1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px var(--orc-mono);color:var(--orc-fg3)}
.orc-panel__baseline--red{color:var(--orc-error)}
.orc-activity-run{display:flex;align-items:center;gap:5px;min-width:0;flex-wrap:wrap;margin-bottom:8px}
.orc-activity-run select{min-width:0;max-width:100%;flex:1 1 150px}
.orc-preview-list{margin:4px 0;padding-left:20px}
.orc-contract-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--orc-mono)}
.orc-feed{margin:0;padding:0;list-style:none}
.orc-feed .orc-ev{padding:8px 0;align-items:baseline}
.orc-feed .orc-ev--message,.orc-feed .orc-ev--final{color:var(--orc-fg);font-size:13px;line-height:19px}
.orc-feed .orc-ev--steer{margin:5px -7px;padding:8px 7px;border-radius:7px;background:var(--orc-active);color:var(--orc-fg)}
.orc-feed .orc-ev--action,.orc-feed .orc-ev--file{color:var(--orc-fg3);font-size:11px;line-height:16px}
.orc-feed__tools{flex:1 1 auto;min-width:0}
.orc-feed__tools summary{display:flex;align-items:center;gap:6px;min-width:0;cursor:pointer;list-style:none}
.orc-feed__tools summary::-webkit-details-marker{display:none}
.orc-feed__tool-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--orc-mono)}
.orc-feed__expand{margin-left:auto;transition:transform 150ms ease-out}
.orc-feed__tools[open] .orc-feed__expand{transform:rotate(180deg)}
.orc-feed__tools ul{margin:5px 0 0;padding:0;list-style:none;border-left:1px solid var(--orc-line)}
.orc-feed__tools li{padding:2px 0 2px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--orc-mono)}
.orc-ev{display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--orc-sep)}
.orc-ev__time{flex:none;width:38px;color:var(--orc-fg3);font-variant-numeric:tabular-nums;font-style:normal}
.orc-ev__kind{flex:none;width:14px;color:var(--orc-fg3);text-align:center}
.orc-ev__text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.orc-ev--problem{color:var(--orc-error)}
.orc-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}
.orc-link{display:block;width:100%;text-align:left;min-height:24px;padding:3px 6px;border:0;border-radius:6px;background:transparent;color:var(--orc-fg2);font:inherit;cursor:pointer;overflow-wrap:anywhere}
.orc-link:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-link[aria-pressed="true"]{background:var(--orc-active);color:var(--orc-fg)}
.orc-code{margin:8px 0 0;padding:8px;max-height:320px;overflow:auto;border:1px solid var(--orc-hair);border-radius:8px;background:var(--orc-bg);color:var(--orc-fg2);font:var(--dsw-font-xxxs-11,11px/16px ui-monospace,monospace);font-family:var(--orc-mono);white-space:pre}
.orc-diff__add{color:var(--orc-ok)}
.orc-diff__del{color:var(--orc-error)}
.orc-preview-controls{display:flex;gap:6px;align-items:center;margin:8px 0;flex-wrap:wrap}
.orc-preview-controls button,.orc-preview-modal>button{border:1px solid var(--orc-hair);border-radius:6px;padding:5px 9px;background:var(--orc-layer2);color:var(--orc-fg);cursor:pointer;font:inherit}
.orc-preview-controls button[aria-pressed="true"]{background:var(--orc-active)}
.orc-preview-key{color:var(--orc-accent)}.orc-preview-comment{color:var(--orc-fg3)}
.orc-preview{min-width:0}.orc-preview-pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:10px}.orc-preview-side{min-width:0;overflow:auto;border:1px solid var(--orc-hair);border-radius:8px;background:var(--orc-bg);padding:8px}.orc-preview-side>header{color:var(--orc-fg3);font-size:11px;margin-bottom:6px}.orc-preview-checker{background-color:#ddd;background-image:linear-gradient(45deg,#aaa 25%,transparent 25%),linear-gradient(-45deg,#aaa 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#aaa 75%),linear-gradient(-45deg,transparent 75%,#aaa 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0;overflow:auto;text-align:center;cursor:zoom-in;display:block;width:100%;border:0;padding:0;font:inherit;color:inherit}.orc-preview-checker img{display:block;margin:auto}.orc-preview-frame{width:100%;height:400px;border:1px solid var(--orc-hair);background:white}.orc-preview-table{max-height:400px;overflow:auto}.orc-preview-table table{border-collapse:collapse;white-space:nowrap}.orc-preview-table th,.orc-preview-table td{padding:4px 8px;border:1px solid var(--orc-hair)}.orc-preview-table th{position:sticky;top:0;background:var(--orc-layer2)}.orc-preview-tree{padding-left:12px;font-family:var(--orc-mono);overflow:auto}.orc-preview-markdown{line-height:1.5}.orc-preview-markdown p{margin:4px 0}.orc-preview-heading{display:block;margin:8px 0}.orc-preview-fence,.orc-preview-markdown pre{font-family:var(--orc-mono);white-space:pre-wrap;margin:0}.orc-preview-lines>div{display:flex;gap:12px}.orc-preview-lines span{min-width:28px;text-align:right;color:var(--orc-fg3);user-select:none}.orc-preview-font{font-size:24px;line-height:1.5}.orc-preview-dxf{overflow:auto}.orc-preview-modal{position:fixed;inset:3vh 3vw;z-index:9999;overflow:auto;background:var(--orc-layer2);color:var(--orc-fg);border:1px solid var(--orc-hair);border-radius:12px;box-shadow:0 16px 60px #0008;padding:16px}.orc-preview-modal h2{font-size:14px;overflow-wrap:anywhere}.orc-preview--expanded .orc-preview-frame{height:70vh}.orc-preview-pair--overlay{display:block;position:relative}.orc-preview-pair--overlay .orc-preview-side:nth-child(2){position:absolute;inset:0;clip-path:inset(0 0 0 var(--orc-reveal,50%));pointer-events:none}

/* «Итог работы»: the worker's own words, above the feed — a quiet card, not an alert. */
.orc-report{border:1px solid var(--orc-hair);border-radius:8px;background:var(--orc-layer2);padding:8px 10px}
.orc-report__head{display:flex;align-items:center}
.orc-report__head .orc-disclose,.orc-report__title{color:var(--orc-fg2);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);font-weight:600}
.orc-report__head .orc-disclose{padding:0}
.orc-report__head{display:flex;align-items:center;min-height:20px}
.orc-report__head .orc-disclose{padding:0;color:var(--orc-fg2);
  font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);font-weight:600;letter-spacing:.01em}
.orc-report__title{color:var(--orc-fg2);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);font-weight:600;letter-spacing:.01em}
.orc-report__body{margin-top:5px;color:var(--orc-fg);font:var(--dsw-font-xs-13,13px/20px system-ui,sans-serif)}
.orc-report__body strong{font-weight:650}
.orc-report__link{padding:0;border:0;border-radius:4px;background:transparent;color:var(--orc-accent);font:inherit;cursor:pointer}
.orc-report__link:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-report__p{margin:0}
.orc-report__p+.orc-report__p{margin-top:6px}
.orc-report__list{margin:4px 0 0;padding-left:18px}
.orc-report__heading{margin:10px 0 2px;color:var(--orc-fg2);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);font-weight:600;letter-spacing:.01em}
.orc-report__heading:first-child{margin-top:0}
.orc-report__tick{color:var(--orc-fg3)}
.orc-report__list li{padding:1px 0}
.orc-report__list li::marker{color:var(--orc-fg3)}
.orc-report__body code{padding:0 3px;border-radius:4px;background:var(--orc-bg);font-family:var(--orc-mono);font-size:11px}
.orc-report__note{margin:7px 0 0;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif)}
.orc-report__link{display:block;margin-top:8px;padding:0;border:0;background:transparent;color:var(--orc-accent);font:inherit;cursor:pointer}
.orc-vcheck{margin:0 0 8px;padding:7px 9px;border-radius:7px;background:var(--orc-layer2);color:var(--orc-fg2);font-size:12px;line-height:18px;overflow-wrap:anywhere}.orc-vcheck p{margin:0}.orc-vcheck__head{color:var(--orc-fg)}.orc-vcheck__note{margin-top:2px;white-space:pre-wrap}
.orc-verdict{padding:7px 9px;border-radius:7px;background:var(--orc-layer2);color:var(--orc-fg2);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.orc-verdict__mark{margin-right:8px;color:var(--orc-fg2);font-weight:700}
.orc-verdict--result .orc-verdict__mark{color:var(--orc-ok)}
.orc-verdict--disputed .orc-verdict__mark{color:var(--orc-warn)}
.orc-verdict__facts{display:flex;flex-wrap:wrap;gap:5px;margin:7px 0 9px}
.orc-verdict__fact{padding:2px 7px;border-radius:999px;background:var(--orc-layer2);color:var(--orc-fg2);font-size:11px;line-height:16px}
.orc-verdict__fact--warn{color:var(--orc-warn)}
.orc-verdict__fact--link{border:0;font-family:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.orc-verdict__fact--link:focus-visible{outline:2px solid var(--orc-accent);outline-offset:2px}
.orc-report__pointer{animation:orc-report-pointer 1.8s ease-out}
@keyframes orc-report-pointer{from{background:color-mix(in srgb,var(--orc-accent) 22%,transparent)}to{background:transparent}}
@media (prefers-reduced-motion:reduce){.orc-report__pointer{animation:none;background:color-mix(in srgb,var(--orc-accent) 22%,transparent)}}
.orc-report__risk-note{margin:3px 0 0;color:var(--orc-fg3);font-size:11px;line-height:16px}
.orc-report__risk{background:color-mix(in srgb,var(--orc-warn) 13%,transparent);border-radius:3px;box-decoration-break:clone}
.orc-dep-warning{display:block;margin-top:4px;color:var(--orc-warn);font-size:11px;line-height:16px}

/* Graph */
.orc-graph-wrap{position:relative;height:100%;min-height:320px}
.orc-graph{position:absolute;inset:0;overflow:hidden;cursor:grab;touch-action:none;
  background-color:var(--orc-bg);background-image:radial-gradient(var(--orc-line) 1px,transparent 1px);background-size:18px 18px}
.orc-graph:active{cursor:grabbing}
.orc-gworld{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
.orc-gedges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.orc-glane{position:absolute;border:1px dashed var(--orc-line);border-radius:12px;background:#ffffff05;pointer-events:none}
/* The lane's name lives inside its own frame — a set change can never drop it onto a neighbour. */
.orc-glane b{position:absolute;top:5px;left:10px;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);font-weight:600;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
.orc-glane__head{position:absolute;top:4px;left:10px;display:flex;align-items:center;gap:10px;pointer-events:auto}
.orc-glane__head b{position:static}
.orc-glane__head button{border:0;background:transparent;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);cursor:pointer}
.orc-glane__head button:hover,.orc-glane__head button:focus-visible{color:var(--orc-fg);text-decoration:underline}

.orc-gnode{position:absolute;left:0;top:0;will-change:transform;transition:opacity 160ms ease-out}
.orc-gnode--faded{opacity:.4}
.orc-gnode--ghost{pointer-events:none}
.orc-gnode__body{display:block;position:relative;width:100%;height:64px;padding:7px 10px 7px 13px;border:1px solid var(--orc-hair);border-radius:9px;
  background:var(--orc-layer1);color:inherit;font:inherit;text-align:left;cursor:pointer;box-shadow:0 1px 0 #0000004d}
.orc-gnode__body:hover{background:var(--orc-layer2);border-color:var(--orc-line)}
.orc-gnode__body[aria-pressed="true"]{border-color:var(--orc-fg);box-shadow:0 0 0 2px var(--orc-active)}
.orc-gnode__body--dim{opacity:.62}
.orc-gnode__body--decision{border-style:dashed}
.orc-gnode__body--lane{border-color:var(--orc-ok);background:var(--orc-layer2)}
.orc-gnode--lane .orc-gnode__body{height:56px;border-radius:9px}
.orc-gnode--lane .orc-gnode__title{height:18px;white-space:nowrap;display:block;text-overflow:ellipsis}
.orc-gfan{position:absolute;width:210px;z-index:9;pointer-events:auto}
.orc-gfan--motion{animation:orc-fan-in 160ms cubic-bezier(.2,.8,.2,1) both}
.orc-gfan[data-side="left"]{transform-origin:right top}
.orc-gfan[data-side="right"]{transform-origin:left top}
@keyframes orc-fan-in{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
.orc-gfan[data-side="left"].orc-gfan--motion{animation-name:orc-fan-in-left}
@keyframes orc-fan-in-left{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:translateX(0)}}
.orc-gfan--closing,.orc-gfan[data-side="left"].orc-gfan--closing{animation:none;opacity:0;transform:translateX(-8px);pointer-events:none;transition:transform 160ms cubic-bezier(.2,.8,.2,1),opacity 160ms ease-out}
.orc-gfan[data-side="left"].orc-gfan--closing{transform:translateX(8px)}
.orc-gfan__card{position:absolute;left:0;width:100%;height:32px;display:flex;align-items:center;gap:8px;overflow:hidden;padding:0 9px;border:1px solid var(--orc-line);border-radius:7px;background:var(--orc-layer2);color:var(--orc-fg);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);text-align:left;cursor:pointer;box-shadow:0 2px 8px #0003}
.orc-gfan__card:hover,.orc-gfan__card:focus-visible{border-color:var(--orc-accent);outline:2px solid var(--orc-active);outline-offset:1px}
.orc-gfan__id{flex:none;color:var(--orc-fg3);font-weight:700}
.orc-gfan__title{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
@media (prefers-reduced-motion:reduce){.orc-gfan--motion{animation:none}}
.orc-gnode--guest .orc-gnode__body{background:color-mix(in srgb,var(--orc-layer1) 68%,var(--orc-bg));border-style:dashed}
.orc-gnode__guest-label{display:block;color:var(--orc-fg3);font-size:10px;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-card--lane{display:flex;flex-direction:column;gap:3px;border-color:var(--orc-ok);background:var(--orc-layer2);text-align:left}
.orc-gnode__strip{position:absolute;left:0;top:8px;bottom:8px;width:4px;border-radius:0 3px 3px 0;overflow:hidden;transition:background-color 220ms ease}
.orc-gnode__strip--running::after{content:"";position:absolute;inset:-60% 0;background:linear-gradient(180deg,transparent 20%,#ffffffad 50%,transparent 80%);animation:orc-strip-flow 1.6s linear infinite}
.orc-gnode__strip--in_review{animation:orc-strip-review 2s ease-in-out infinite}
@keyframes orc-strip-flow{from{transform:translateY(-35%)}to{transform:translateY(35%)}}
@keyframes orc-strip-review{50%{opacity:.6}}
@media (prefers-reduced-motion:reduce){.orc-gnode__strip--running::after{animation:none;inset:0;background:#ffffff55}.orc-gnode__strip--in_review{animation:none;filter:brightness(1.35)}}
.orc-gnode__title{display:-webkit-box;height:32px;font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);line-height:16px;font-weight:600;overflow:hidden;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.orc-gnode__meta{display:flex;align-items:center;gap:5px;margin-top:2px;height:16px;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);white-space:nowrap;overflow:hidden}
.orc-gnode__meta em{font-style:normal;overflow:hidden;text-overflow:ellipsis}
.orc-gnode__model{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.orc-gnode__fact{flex:none;font-variant-numeric:tabular-nums}
.orc-gnode__badge{position:absolute;top:-7px;right:-7px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--orc-error);color:#fff;
  font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);font-weight:700;text-align:center}
.orc-gnode__dep{position:absolute;left:7px;bottom:-7px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--orc-warn);color:var(--orc-bg);font-size:11px;line-height:16px;font-weight:700;text-align:center}
.orc-gnode__hand{flex:none;color:var(--orc-warn,var(--orc-fg2));font-size:10px;line-height:1}
.orc-panel__choice{margin:2px 0 0;color:var(--orc-fg2)}
.orc-panel__hand{margin-left:6px;color:var(--orc-warn,var(--orc-fg2))}
.orc-gnode__pin{position:absolute;top:-6px;left:-6px;color:var(--orc-fg3);font-size:11px;line-height:1}
.orc-gnode__ping{position:absolute;inset:-1px;border-radius:9px;border:2px solid var(--orc-ping,var(--orc-accent));opacity:0;pointer-events:none}
/* «Пока тебя не было»: what changed behind a hidden tab keeps an outline for a few seconds. */
.orc-gnode--away .orc-gnode__body{border-color:var(--orc-accent);box-shadow:0 0 0 1px var(--orc-accent)}
/* Review highlight: amber is «your turn» everywhere on the screen — the same colour as the pill,
   the queue and the timeline's wait segments. */
.orc-gnode--review .orc-gnode__body{border-color:var(--orc-warn);box-shadow:0 0 0 2px var(--orc-warn)}
.orc-gnode--review .orc-gnode__body[aria-pressed="true"]{border-color:var(--orc-fg);box-shadow:0 0 0 2px var(--orc-warn)}
/* The «!» badge yields the corner: «принять» is the action a waiting node wants. */
.orc-gnode--review .orc-gnode__badge{top:auto;bottom:-7px}
.orc-gnode__review{position:absolute;top:-11px;right:-8px;z-index:2;min-height:24px;padding:3px 9px;border:1px solid var(--orc-warn);
  border-radius:999px;background:var(--orc-layer1);color:var(--orc-warn);
  font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);font-weight:600;white-space:nowrap;cursor:pointer;
  box-shadow:0 1px 5px #00000059}
.orc-gnode__review:hover{background:var(--orc-warn);color:var(--orc-bg)}
/* «Только приёмка»: the rest of the plan steps back to ~25 %, the waiting nodes stay full. */
.orc-gnode--dim{opacity:.25}
.orc-gedge--dim{opacity:.25}

.orc-gedge{fill:none;stroke:var(--orc-fg3);stroke-width:1.4;opacity:.75;transition:opacity 160ms ease-out}
.orc-gedge--ok{stroke:var(--orc-fg3);opacity:.9}
.orc-gedge--wait{stroke:var(--orc-line);stroke-dasharray:4 4}
.orc-gedge--bad{stroke:var(--orc-error);stroke-dasharray:4 4}
.orc-gedge--on{opacity:1;stroke:var(--orc-fg2);stroke-width:1.8}
/* Highlighting a chain must never erase the problem colour. */
.orc-gedge--bad.orc-gedge--on{stroke:var(--orc-error);stroke-width:2}
.orc-gedge--off{opacity:.28}
.orc-gedge--flow{stroke:var(--orc-ok);stroke-width:2.2;opacity:1}
.orc-garrow{fill:var(--orc-fg3)}
.orc-garrow--wait{fill:var(--orc-line)}
.orc-garrow--bad{fill:var(--orc-error)}
.orc-gedge-mark{position:absolute;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;pointer-events:none;animation:orc-mark 1.8s ease-out both}
@keyframes orc-mark{0%{opacity:0;transform:scale(.6)}12%{opacity:1;transform:scale(1)}80%{opacity:1}100%{opacity:0}}

/* Far level of detail (camera DETAIL_SCALE): below it a title is grey noise, so a card becomes a block
   in its state colour and the words step out. Nothing changes size — the switch is a crossfade, and
   hidden text is visibility:hidden after the fade, so the browser paints none of it while zooming. */
.orc-gnode__body{transition:background-color 180ms ease-out,border-color 180ms ease-out}
.orc-gnode__body>*,.orc-glane__head,.orc-gnode__review{transition:opacity 180ms ease-out,visibility 0s linear 0s,background-color 220ms ease}
.orc-graph--far .orc-gnode__body{background:var(--orc-tone,var(--orc-fg3));border-color:transparent;box-shadow:none}
.orc-graph--far .orc-gnode__body[aria-pressed="true"]{border-color:var(--orc-fg);box-shadow:0 0 0 2px var(--orc-active)}
.orc-graph--far .orc-gnode__body:hover{background:var(--orc-tone,var(--orc-fg3));border-color:var(--orc-fg)}
.orc-graph--far .orc-gnode__body>*,.orc-graph--far .orc-glane__head,.orc-graph--far .orc-gnode__review{opacity:0;visibility:hidden;transition:opacity 180ms ease-out,visibility 0s linear 180ms}
/* Edges step back to a trace; the critical path and the hovered or selected task's chain stay, drawn
   at a constant screen width so they do not thin out to nothing with the zoom. */
.orc-graph--far .orc-gedge{opacity:.14;vector-effect:non-scaling-stroke}
.orc-graph--far .orc-gedge--crit{opacity:.9;stroke:var(--orc-fg2);stroke-width:2}
.orc-graph--far .orc-gedge--on{opacity:1;stroke:var(--orc-fg);stroke-width:2}
.orc-graph--far .orc-gedge--off:not(.orc-gedge--crit){opacity:.06}
/* Lane names in the far view: an overlay in screen pixels (lane-labels.ts places them), so 11 px at any
   zoom. Anchored at their left edge, vertically centred on the lane, cut short before the plan starts. */
.orc-glabels{position:absolute;inset:0;overflow:hidden;pointer-events:none;opacity:0;visibility:hidden;transition:opacity 180ms ease-out,visibility 0s linear 180ms}
.orc-graph--far .orc-glabels{opacity:1;visibility:visible;transition:opacity 180ms ease-out,visibility 0s linear 0s}
.orc-glabel{position:absolute;left:0;top:0;max-width:116px;margin-top:-6px;padding:0 4px;border-radius:4px;overflow:hidden;text-overflow:ellipsis;
  background:color-mix(in srgb,var(--orc-bg) 82%,transparent);color:var(--orc-fg2);font:var(--dsw-font-xxxs-11,11px/12px system-ui,sans-serif);
  line-height:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
.orc-gtip{position:absolute;z-index:8;display:flex;flex-direction:column;gap:1px;max-width:260px;padding:6px 9px;transform:translate(-50%,calc(-100% - 8px));
  border:1px solid var(--orc-line);border-radius:7px;background:var(--orc-layer2);box-shadow:0 2px 8px #0000004d;pointer-events:none;
  font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif)}
.orc-gtip--below{transform:translate(-50%,8px)}
.orc-gtip__id{color:var(--orc-fg3);font-weight:700}
.orc-gtip__title{color:var(--orc-fg);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-gtip__worker{color:var(--orc-fg2)}
@media (prefers-reduced-motion:reduce){.orc-gnode__body,.orc-gnode__body>*,.orc-glane__head,.orc-gnode__review,.orc-glabels,.orc-graph--far .orc-glabels,.orc-graph--far .orc-gnode__body>*,.orc-graph--far .orc-glane__head,.orc-graph--far .orc-gnode__review{transition:none}}

/* The tools keep clear of the minimap corner; below 640px the map is gone and the row is free again. */
.orc-gtools{position:absolute;left:10px;bottom:10px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:calc(100% - 194px)}
@media (max-width:640px){.orc-gtools{max-width:calc(100% - 20px)}}
.orc-ghint{color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif)}
.orc-gnote{position:absolute;left:10px;top:10px;margin:0;padding:4px 9px;border-radius:7px;border:1px solid var(--orc-line);background:var(--orc-layer1);color:var(--orc-fg2);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}

/* Minimap: the whole plan in the corner, the visible area as a frame you can drag. */
.orc-gmap{position:absolute;right:10px;bottom:10px;border:1px solid var(--orc-line);border-radius:9px;background:color-mix(in srgb,var(--orc-layer1) 88%,transparent);
  box-shadow:0 1px 6px #00000047;cursor:pointer;touch-action:none;overflow:hidden}
.orc-gmap__node{position:absolute;border-radius:1.5px;opacity:.75;transition:opacity 160ms ease-out}
.orc-gmap__node--on{opacity:1;box-shadow:0 0 0 1px var(--orc-fg)}
.orc-gmap__node--dim{opacity:.25}
.orc-gmap__frame{position:absolute;left:0;top:0;width:0;height:0;border:1px solid var(--orc-fg2);border-radius:3px;background:#ffffff14;pointer-events:none}
@media (max-width:640px){.orc-gmap{display:none}}

/* ⌘K: finding a task by name instead of panning for it. */
.orc-gsearch{position:absolute;left:50%;top:12px;transform:translateX(-50%);width:min(380px,calc(100% - 24px));padding:6px;
  border:1px solid var(--orc-line);border-radius:11px;background:var(--orc-layer1);box-shadow:0 8px 24px #00000059}
.orc-gsearch__field{width:100%;min-height:28px;padding:4px 9px;border:1px solid var(--orc-line);border-radius:7px;background:var(--orc-layer2);color:var(--orc-fg);font:inherit}
.orc-gsearch__empty{margin:6px 4px 2px;color:var(--orc-fg3);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}
.orc-gsearch__list{margin:4px 0 0;padding:0;list-style:none;max-height:246px;overflow:auto}
.orc-gsearch__item{display:flex;align-items:baseline;gap:6px;width:100%;min-height:26px;padding:4px 6px;border:0;border-radius:7px;background:transparent;color:var(--orc-fg2);font:inherit;text-align:left;cursor:pointer}
.orc-gsearch__item:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-gsearch__item[aria-current="true"]{background:var(--orc-active);color:var(--orc-fg)}
.orc-gsearch__title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-gsearch__keys{margin:5px 4px 1px;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif)}

/* Insight screens: plan timeline, run trace */
.orc-insight{display:flex;flex-direction:column;gap:12px;padding:14px 0 22px}
/* Blocks take the window; the sentences inside them keep a reading measure. */
.orc-answer{margin:8px 0 0;max-width:74ch;font:var(--dsw-font-s-14,14px/22px system-ui,sans-serif);color:var(--orc-fg)}
.orc-answer b{font-weight:650}
.orc-num{font-variant-numeric:tabular-nums}
.orc-wk{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:17px;margin-right:6px;padding:0 5px;border-radius:5px;
  background:var(--orc-layer2);color:var(--orc-fg2);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);font-weight:700;letter-spacing:.02em}
.orc-more{min-height:24px;margin-top:6px;padding:2px 0;border:0;background:transparent;color:var(--orc-fg3);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);cursor:pointer}
.orc-more:hover{color:var(--orc-fg)}
.orc-legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:10px;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif)}
.orc-sw{display:inline-block;width:10px;height:10px;margin-right:5px;border-radius:3px;vertical-align:-1px;background:var(--orc-fg3)}
.orc-sw--run{background:var(--orc-k-model)}
.orc-sw--review{background:transparent;border:1.5px dashed var(--orc-warn)}
.orc-sw--dep{background:var(--orc-layer2);background-image:repeating-linear-gradient(135deg,#ffffff26 0 3px,transparent 3px 7px)}
.orc-facts{display:flex;flex-wrap:wrap;gap:8px 22px;margin:12px 0 0}
.orc-facts div{margin:0}
.orc-facts dt{color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);text-transform:uppercase;letter-spacing:.04em}
.orc-facts dd{margin:2px 0 0;color:var(--orc-fg);font-variant-numeric:tabular-nums}
.orc-facts__warn{color:var(--orc-warn)}
.orc-table{width:100%;border-collapse:collapse;margin-top:4px}
.orc-table th,.orc-table td{padding:6px 5px;text-align:left;font-weight:normal;border-bottom:1px solid var(--orc-sep)}
.orc-table thead th{color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);text-transform:uppercase;letter-spacing:.04em}
.orc-table tbody th{color:var(--orc-fg);font-weight:500}

/* Plan timeline: the name column is a share of the track, not a fixed stub — wide windows let the
   title run to ~50 characters before the ellipsis, and --orc-tl-name stays the single measure that
   the axis, the rows and the «сейчас» line all align to. */
.orc-tl{position:relative;margin-top:8px;--orc-tl-name:clamp(186px,24%,340px)}
.orc-tl__axis{position:relative;height:16px;margin-left:var(--orc-tl-name);color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);font-variant-numeric:tabular-nums}
/* translateX(-p%) at left:p% pulls a label back by its own share of the width: the first mark starts
   at the track edge, the last ends at it, and none ever spills outside. */
.orc-tl__axis span{position:absolute;top:0;white-space:nowrap}
.orc-tl__rows{margin:4px 0 0;padding:0;list-style:none}
.orc-tl__row{display:flex;align-items:center;height:30px}
.orc-tl__name{display:flex;align-items:center;flex:0 0 calc(var(--orc-tl-name) - 6px);min-width:0;min-height:24px;margin-right:6px;padding:2px 4px;border:0;border-radius:6px;
  background:transparent;color:var(--orc-fg);font:inherit;text-align:left;cursor:pointer}
.orc-tl__name:hover{background:var(--orc-hover)}
.orc-tl__name[aria-pressed="true"]{background:var(--orc-active)}
.orc-tl__title{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.orc-tl__track{position:relative;flex:1 1 auto;height:24px}
.orc-tl__bar{position:absolute;top:5px;height:14px;min-width:3px;padding:0;border:0;border-radius:4px;cursor:pointer}
.orc-tl__bar--run{background:var(--orc-k-model)}
.orc-tl__bar--run:hover{filter:brightness(1.15)}
.orc-tl__bar--review{background:transparent;border:1.5px dashed var(--orc-warn)}
.orc-tl__bar--dep{background-color:var(--orc-layer2);background-image:repeating-linear-gradient(135deg,#ffffff26 0 3px,transparent 3px 7px)}
.orc-tl__now{position:absolute;top:18px;bottom:0;width:1.5px;background:var(--orc-fg);opacity:.7;pointer-events:none}

/* Run trace */
.orc-ledger__totals{display:flex;gap:16px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--orc-hair);background:var(--orc-layer1);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}
.orc-ledger{display:flex;flex:1 1 auto;flex-direction:column;min-height:0}
.orc-ledger__totals span{display:flex;flex-direction:column;gap:2px;font-variant-numeric:tabular-nums}.orc-ledger__totals b{color:var(--orc-fg3);font-weight:500}
.orc-ledger__overview{padding:8px 14px;border-bottom:1px solid var(--orc-hair);background:var(--orc-layer1)}
.orc-ledger__overview-head{display:flex;align-items:center;gap:12px;font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}.orc-ledger__overview-head span{color:var(--orc-fg3);font-variant-numeric:tabular-nums}.orc-ledger__overview-head button{margin-left:auto}
.orc-ledger__chart{position:relative;height:88px;margin:6px 0 2px;cursor:crosshair;touch-action:none;background:repeating-linear-gradient(to right,var(--orc-hair) 0 1px,transparent 1px 10%)}
.orc-ledger__turnmark{position:absolute;top:0;bottom:0;border-left:1px dashed var(--orc-fg3);pointer-events:none}.orc-ledger__span{position:absolute;height:12px;min-width:3px;border:0;border-radius:2px;padding:0;cursor:pointer;opacity:.85}.orc-ledger__span:hover{opacity:1;box-shadow:0 0 0 2px var(--orc-fg)}.orc-ledger__span--mark{width:3px}.orc-ledger__focus{position:absolute;top:0;bottom:0;background:var(--orc-ok);opacity:.15;pointer-events:none}.orc-ledger__usage{width:100%;height:25px;display:block}
.orc-ledger__controls{display:flex;align-items:center;gap:5px;padding:8px 12px;flex-wrap:wrap;border-bottom:1px solid var(--orc-hair)}.orc-ledger__controls input{width:min(220px,100%);min-height:28px}.orc-ledger__filter{border:1px solid var(--orc-hair);border-radius:5px;padding:3px 7px;background:var(--orc-layer1);color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);cursor:pointer}.orc-ledger__filter[aria-pressed="true"]{color:var(--orc-fg);border-color:var(--orc-fg3)}
.orc-ledger__body{display:flex;flex:1 1 auto;min-height:0}.orc-ledger__list{flex:1 1 auto;min-width:0;overflow:auto}.orc-ledger__item{position:absolute;left:0;right:0;height:42px}.orc-ledger__row{width:100%;height:100%;display:flex;align-items:center;gap:8px;padding:0 12px;border:0;border-bottom:1px solid var(--orc-hair);background:transparent;color:var(--orc-fg);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);text-align:left;cursor:pointer}.orc-ledger__row:hover,.orc-ledger__row[aria-pressed="true"]{background:var(--orc-layer2)}.orc-ledger__number{width:40px;flex:none;color:var(--orc-fg3);font-variant-numeric:tabular-nums}.orc-ledger__icon{width:12px;flex:none}.orc-ledger__label{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.orc-ledger__label em{font-style:normal;color:var(--orc-fg3)}.orc-ledger__duration{width:64px;text-align:right;flex:none;font-variant-numeric:tabular-nums;color:var(--orc-fg2)}.orc-ledger__tokens{width:110px;text-align:right;flex:none;font-variant-numeric:tabular-nums;color:var(--orc-fg3)}
.orc-ledger__inspector{width:340px;flex:0 0 340px;padding:12px 14px;border-left:1px solid var(--orc-hair);background:var(--orc-layer1);overflow:auto}.orc-ledger__inspector h4{margin:14px 0 4px}.orc-ledger__inspector pre{margin:0;padding:8px;max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--orc-layer2);border-radius:5px;font:11px/1.5 ui-monospace,monospace}
@media(max-width:1150px){.orc-ledger__inspector{width:280px;flex-basis:280px}.orc-ledger__tokens{width:60px}}
@media(max-width:850px){.orc-ledger__body{flex-direction:column}.orc-ledger__inspector{width:auto;flex:0 0 220px;border-left:0;border-top:1px solid var(--orc-hair)}}
.orc-ledger__overview-tools{display:flex;gap:6px;flex-wrap:wrap}.orc-ledger__selection{position:absolute;top:0;bottom:0;box-shadow:0 0 0 2px var(--orc-fg);pointer-events:none}/* The paging bar is a row of its own above the list: the list scrolls inside its own box and never runs under the bar. */
.orc-ledger__paging{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 12px;border-bottom:1px solid var(--orc-hair);background:var(--orc-layer1);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}.orc-ledger__inspector>.orc-btn{margin-top:6px}.orc-ledger__span[aria-current="step"]{box-shadow:0 0 0 2px var(--orc-fg);opacity:1}
.orc-tr{display:flex;flex-direction:column;height:100%;min-height:0}
.orc-tr__head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--orc-hair);background:var(--orc-layer1)}
.orc-tr__title{margin:0;font:var(--dsw-font-strong-xs-13,600 13px/20px system-ui,sans-serif);font-weight:600}
.orc-tr__status{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;background:var(--orc-layer2);color:var(--orc-fg2);
  font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);font-variant-numeric:tabular-nums}
.orc-tr__status--live{color:var(--orc-ok)}
.orc-tr__body{display:flex;flex:1 1 auto;min-height:0;overflow:auto}
.orc-tr__lanes{flex:1 1 auto;min-width:0;padding:12px 14px}
.orc-tr__lane{display:flex;align-items:center;min-height:28px}
.orc-tr__lname{flex:0 0 96px;width:96px;color:var(--orc-fg3);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}
.orc-tr__track{position:relative;flex:1 1 auto;height:24px}
.orc-tr__step{position:absolute;top:0;height:24px;min-width:4px;padding:0;border:0;background:transparent;cursor:pointer}
.orc-tr__step::before{content:"";display:block;height:12px;margin-top:6px;border-radius:3px;background:var(--orc-k,var(--orc-fg3));
  transition:transform 150ms cubic-bezier(.23,1,.32,1)}
.orc-tr__step:hover::before{transform:scaleY(1.2)}
.orc-tr__step--mark{width:18px;margin-left:-9px}
.orc-tr__step--mark::before{height:16px;margin-top:4px;border-radius:5px}
.orc-tr__step--approx::before{background-image:repeating-linear-gradient(135deg,#00000059 0 3px,transparent 3px 7px)}
.orc-tr__step[aria-pressed="true"]::before{transform:scaleY(1.25);box-shadow:0 0 0 2px var(--orc-bg),0 0 0 4px var(--orc-fg)}
.orc-tr__count{display:block;color:var(--orc-bg);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);font-weight:700;text-align:center;
  position:absolute;inset:4px 0 auto;pointer-events:none}
.orc-tr__insp{flex:0 0 320px;width:320px;padding:12px 14px;border-left:1px solid var(--orc-hair);background:var(--orc-layer1);overflow:auto}
.orc-tr__ihead{display:flex;align-items:flex-start;gap:8px}
.orc-tr__it{flex:1 1 auto;margin:0;font:var(--dsw-font-strong-xs-13,600 13px/20px system-ui,sans-serif);font-weight:600;overflow-wrap:anywhere}
.orc-tr__istep+.orc-tr__istep{margin-top:10px;padding-top:10px;border-top:1px solid var(--orc-sep)}
.orc-tr__journal{margin:0;padding:12px 14px;list-style:none;overflow:auto}
.orc-tr__pane{flex:1 1 auto;min-height:0;padding:12px 14px;overflow:auto}
.orc-insp__acts{margin-top:12px;padding-top:10px;border-top:1px solid var(--orc-sep)}
.orc-menu{position:relative}
.orc-menu summary{list-style:none;display:inline-flex}
.orc-menu summary::-webkit-details-marker{display:none}
.orc-menu__list{display:flex;flex-direction:column;align-items:flex-start;gap:2px;margin-top:4px;padding:4px 8px;border:1px solid var(--orc-line);border-radius:8px;background:var(--orc-layer2)}

/* Compare two runs of one task */
.orc-cmp{max-width:1100px}
.orc-cmp__pickers{display:flex;gap:8px;margin:8px 0 12px}
.orc-cmp__row{display:flex;align-items:center;min-height:30px}
.orc-cmp__name{display:flex;align-items:center;flex:0 0 200px;width:200px;color:var(--orc-fg2);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}
.orc-cmp__track{position:relative;flex:1 1 auto;height:18px;border-radius:5px;background:var(--orc-layer2)}
.orc-cmp__step{position:absolute;top:3px;height:12px;min-width:2px;border-radius:3px}
.orc-cmp__step--approx{background-image:repeating-linear-gradient(135deg,#00000059 0 3px,transparent 3px 7px)}
.orc-cmp__meta{flex:0 0 80px;width:80px;text-align:right;color:var(--orc-fg3);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}
.orc-cmp__caption{margin:14px 0 2px;text-align:left;color:var(--orc-fg);font:var(--dsw-font-strong-xs-13,600 13px/20px system-ui,sans-serif);font-weight:600}
.orc-tr__jmeta{margin-left:8px;color:var(--orc-fg3)}
@media (max-width:1100px){
  .orc-tr__body{flex-direction:column}
  .orc-tr__insp{flex:0 0 auto;width:auto;border-left:0;border-top:1px solid var(--orc-hair)}
  .orc-tl{--orc-tl-name:132px}
}

/* Settings section (the «Оркестрация» card in the dsh Settings window): same blocks and rows as the
   console, scoped under .orc-settings because it renders outside .orc-root. */
.orc-settings{display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--orc-fg);
  font:var(--dsw-font-xs-13,13px/20px system-ui,sans-serif)}
.orc-set__list{margin:0;padding:0;list-style:none}
.orc-set__list>li{padding:6px 0}
.orc-set__list>li+li{border-top:1px solid var(--orc-sep)}
/* One grid template is shared by the column caption and every worker row, so «Оплата»,
   «Где используется» and the switches line up across provider groups. */
.orc-wcap,.orc-wrow__line{display:grid;grid-template-columns:minmax(0,1fr) 74px minmax(110px,32%) 32px 26px;
  column-gap:12px;align-items:center}
.orc-wcap{margin:8px 0 0;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif)}
.orc-wcap>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-wcap__sw{justify-self:end}
.orc-wrow__line{min-height:24px}
.orc-wrow__menu-button{width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:var(--orc-fg2);font:700 16px/20px system-ui;cursor:pointer}
.orc-wrow__menu-button:hover,.orc-wrow__menu-button[aria-expanded="true"]{background:var(--orc-hover);color:var(--orc-fg)}
.orc-wrow__actions,.orc-wrow__edit,.orc-wrow__confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:5px 0 4px 30px}
.orc-preset-row__line{display:grid;grid-template-columns:minmax(130px,1fr) minmax(120px,1.5fr) minmax(172px,auto);gap:12px;align-items:center;min-height:34px}
.orc-preset-row__use{min-width:0;color:var(--orc-fg3);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-preset-row__line .orc-wrow__actions{justify-self:end;flex-wrap:nowrap;margin:0;white-space:nowrap}
.orc-preset-row .orc-preset__edit{margin:8px 0 12px;padding:12px;border:1px solid var(--orc-hair);border-radius:8px;background:var(--orc-bg)}
.orc-preset-row .orc-wrow__edit,.orc-preset-row__new-form{margin:4px 0 10px}
.orc-preset-row__new{margin-top:12px;min-height:28px;padding:3px 10px;border:1px solid var(--orc-line);border-radius:7px;background:var(--orc-layer2);color:var(--orc-accent);font:inherit;cursor:pointer}
@media(max-width:570px){.orc-preset-row__line{grid-template-columns:minmax(0,1fr) auto;gap:4px 8px}.orc-preset-row__use{grid-column:1;grid-row:2}.orc-preset-row__line .orc-wrow__actions{grid-column:2;grid-row:1 / 3}}
.orc-wrow__actions button,.orc-wrow__edit button,.orc-wrow__confirm button,.orc-family button,.orc-add button{min-height:26px;padding:3px 9px;border:1px solid var(--orc-line);border-radius:7px;background:var(--orc-layer2);color:var(--orc-fg2);font:inherit;cursor:pointer;transition:transform 120ms ease-out,background-color 120ms ease-out}
.orc-wrow__actions button:hover,.orc-wrow__edit button:hover,.orc-wrow__confirm button:hover,.orc-family button:hover,.orc-add button:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-wrow__actions button:active,.orc-wrow__edit button:active,.orc-wrow__confirm button:active,.orc-family button:active,.orc-add button:active{transform:scale(.97)}
.orc-wrow__edit label{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.orc-wrow__edit .orc-input{min-width:180px}
.orc-wrow__note{margin:1px 0 2px 30px;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif)}
.orc-wrow__confirm{padding:7px 9px;border:1px solid var(--orc-line);border-radius:8px;background:var(--orc-layer2);color:var(--orc-fg2)}
.orc-wrow__confirm span{flex:1 1 100%}
.orc-wrow__confirm .orc-danger{color:var(--orc-error)}
/* Three CLI families read as three rows, not three cramped cards: name, state, the login command,
   and the check button on the right edge — the same rhythm as the worker rows below. */
.orc-family{display:flex;flex-direction:column;margin:10px 0 6px;border:1px solid var(--orc-hair);border-radius:9px;background:var(--orc-bg);overflow:hidden}
.orc-family__item{display:grid;grid-template-columns:96px minmax(0,1fr) auto;align-items:center;gap:10px;min-width:0;padding:8px 10px}
.orc-family__item + .orc-family__item{border-top:1px solid var(--orc-hair)}
.orc-family__name{font-weight:600}
.orc-family__state{color:var(--orc-fg3);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.orc-family code{grid-column:2;grid-row:2;color:var(--orc-fg3);font:11px/16px var(--orc-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.orc-family button{grid-column:3;grid-row:1 / span 2;align-self:center;min-height:24px;padding:3px 9px;font-size:11px;white-space:nowrap}
.orc-family button:disabled,.orc-add button:disabled{opacity:.5;cursor:default}
.orc-add{margin-top:13px;padding-top:10px;border-top:1px solid var(--orc-sep)}
.orc-add .orc-add__trigger{border-style:dashed;color:var(--orc-accent)}
.orc-add__form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px;margin-top:9px;padding:12px;border:1px solid var(--orc-line);border-radius:10px;background:var(--orc-bg)}
.orc-add__form>label{display:flex;flex-direction:column;gap:4px;min-width:0;color:var(--orc-fg2);font-weight:600}
.orc-add__form .orc-input,.orc-add__form .orc-select{width:100%;min-height:28px;font-weight:400}
.orc-add__form .orc-hint{margin:0;font-weight:400}
.orc-add__check,.orc-add__buttons{display:flex;align-items:center;gap:8px;flex-wrap:wrap;grid-column:1 / -1}
.orc-add__check span{color:var(--orc-fg3);font-size:11px}
.orc-add__buttons{justify-content:flex-end;padding-top:8px;border-top:1px solid var(--orc-sep)}
.orc-add__buttons button:first-child{color:var(--orc-accent)}
@media(max-width:570px){.orc-family{grid-template-columns:1fr}.orc-family__item{grid-template-columns:1fr 1fr}.orc-add__form{grid-template-columns:1fr}}
.orc-wrow__who{display:flex;align-items:center;gap:8px;min-width:0}
.orc-wrow__who .orc-wk{margin-right:0}
.orc-wrow__name{flex:1 1 auto;min-width:0}
.orc-wrow__label,.orc-wrow__id{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-wrow__id{color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif)}
.orc-wrow__bill{color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif)}
/* The usage list wraps inside its column — a truncated «…» would hide which classes a worker serves. */
.orc-wrow__use{min-width:0;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/15px system-ui,sans-serif)}
.orc-wrow--off .orc-wrow__name,.orc-wrow--off .orc-wrow__bill,.orc-wrow--off .orc-wrow__use{color:var(--orc-fg3)}
/* The reason field is part of its row: indented under the name, capped short of the dialog width. */
.orc-wrow__reason{display:block;width:min(320px,calc(100% - 30px));margin:2px 0 3px 30px}
.orc-wgroup{margin-top:14px;padding-top:8px;border-top:1px solid var(--orc-sep)}
.orc-wgroup:first-of-type{margin-top:8px;padding-top:0;border-top:0}
.orc-wgroup__name{margin:0;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);
  font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.orc-extra{margin-top:14px;padding-top:8px;border-top:1px solid var(--orc-sep)}
.orc-disclose{display:flex;align-items:center;gap:6px;padding:4px 0;border:0;background:transparent;
  color:var(--orc-fg2);font:inherit;cursor:pointer}
.orc-disclose:hover{color:var(--orc-fg)}
.orc-disclose__mark{display:inline-block;color:var(--orc-fg3);font-size:9px;transition:transform 160ms cubic-bezier(.23,1,.32,1)}
.orc-disclose[aria-expanded="true"] .orc-disclose__mark{transform:rotate(90deg)}
.orc-switch{position:relative;flex:none;width:32px;height:18px;padding:0;border:1px solid var(--orc-line);border-radius:999px;
  background:var(--orc-layer2);cursor:pointer;transition:background-color 160ms ease-out,border-color 160ms ease-out;justify-self:end}
.orc-switch:hover{border-color:var(--orc-fg3)}
.orc-switch::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--orc-fg3);
  transition:transform 160ms cubic-bezier(.23,1,.32,1),background-color 160ms ease-out}
.orc-switch[aria-checked="true"]{background:var(--orc-accent-strong);border-color:transparent}
.orc-switch[aria-checked="true"]::after{transform:translateX(14px);background:#fff}
/* «Порядок по классам задач»: each class is one inset block — name, ordered rows, picker. Rows drag
   by grip or by the row itself; neighbours shift via transform to mark the landing slot. */
.orc-class{margin-top:8px;padding:7px 10px 9px;border:1px solid var(--orc-hair);border-radius:10px;background:var(--orc-bg)}
.orc-class__name{margin:0;color:var(--orc-fg2);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);font-weight:600}
.orc-ord{position:relative;margin:4px 0 0;padding:0;list-style:none}
.orc-ord--live{user-select:none;cursor:grabbing}
.orc-ord--live .orc-step,.orc-ord--live .orc-grip{cursor:grabbing}
.orc-ord__row{display:flex;align-items:center;gap:6px;min-height:26px;padding:1px 4px;border-radius:7px;position:relative}
.orc-ord__row--mv{transition:transform 160ms ease-out}
.orc-ord__row--grab{z-index:1;background:var(--orc-layer2);box-shadow:0 0 0 1px var(--orc-line),0 3px 10px #00000045}
.orc-ord__row--off .orc-ord__name{color:var(--orc-fg3)}
.orc-ord__n{flex:none;width:14px;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);font-variant-numeric:tabular-nums;text-align:right}
.orc-grip{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;min-height:22px;
  padding:0;border:0;border-radius:6px;background:transparent;cursor:grab;touch-action:none}
.orc-grip:hover{background:var(--orc-hover)}
.orc-grip__dots{width:9px;height:15px;
  background-image:radial-gradient(circle at center,var(--orc-fg3) 1.1px,transparent 1.4px);background-size:4.5px 5px}
.orc-grip:hover .orc-grip__dots{background-image:radial-gradient(circle at center,var(--orc-fg2) 1.1px,transparent 1.4px)}
.orc-ord__row--grab .orc-grip{cursor:grabbing}
.orc-ord__row .orc-wk{margin-right:0}
.orc-ord__name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-ord__off{flex:1 1 auto;min-width:0;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-ord__btns{display:flex;flex:none;gap:2px;margin-left:auto}
.orc-step{min-width:22px;min-height:22px;padding:0 4px;border:0;border-radius:6px;background:transparent;color:var(--orc-fg3);font:inherit;line-height:1;cursor:pointer}
.orc-step:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-step:disabled{opacity:.35;cursor:default}
.orc-class__add{margin-top:6px}
.orc-input{min-height:24px;padding:3px 8px;border:1px solid var(--orc-line);border-radius:7px;background:var(--orc-layer2);color:var(--orc-fg);font:inherit}
.orc-input::placeholder{color:var(--orc-fg3)}
.orc-set__status{min-height:18px;margin:0;color:var(--orc-fg3);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}
.orc-set__status--err{color:var(--orc-error)}
.orc-set__empty{margin:0;color:var(--orc-fg3)}

/* Running dot: the only ambient motion, and only while a worker is actually working. */
.orc-pulse{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;animation:orc-breathe 2s ease-in-out infinite}
@keyframes orc-breathe{0%,100%{opacity:1}50%{opacity:.45}}

/* Acceptance queue: the same right-hand column as the task panel — same width, same scroll. */
.orc-queue__bar{display:flex;align-items:flex-start;gap:8px}
.orc-queue__bar .orc-h{flex:1 1 auto;min-width:0}
.orc-queue__x{flex:none;min-width:24px;min-height:24px;padding:0;border:0;border-radius:6px;
  background:transparent;color:var(--orc-fg3);font-size:15px;line-height:1;cursor:pointer}
.orc-queue__x:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-queue__empty{padding:0 14px}
.orc-queue__list{display:flex;flex-direction:column;gap:6px;margin:0;padding:4px 14px 12px;list-style:none}
.orc-queue__other .orc-block__head{margin-bottom:0;padding:4px 14px 0}
.orc-qrow{border:1px solid var(--orc-hair);border-radius:9px;background:var(--orc-layer2);padding:7px 9px}
.orc-qrow__top{display:flex;align-items:baseline;gap:6px;width:100%;min-height:24px;padding:0;border:0;border-radius:4px;
  background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.orc-qrow__top:hover .orc-card__title{text-decoration:underline}
.orc-qrow__chev{flex:none;margin-left:auto;color:var(--orc-fg3)}
.orc-qrow__line{display:flex;align-items:baseline;gap:6px}
/* The report's first line under the title: grey, one line, so the queue stays scannable. */
.orc-qrow__report{display:block;margin-top:2px;color:var(--orc-fg3);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-qrow__verdict{display:block;margin-top:2px;color:var(--orc-fg2);font:var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orc-qrow__verdict .orc-verdict__mark{margin-right:5px}
.orc-qrow__detail{margin-top:6px}
.orc-qrow__files{margin:0;padding:0;list-style:none;color:var(--orc-fg2);
  font:var(--dsw-font-xxxs-11,11px/16px ui-monospace,monospace);font-family:var(--orc-mono)}
.orc-qrow__files li{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 0}
.orc-qrow__acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}

/* «Оркестрация» tab in the right pane: ~340 px next to the chat — the same row language as the
   queue, a header that says whose chat leads the plan, and a footer that hands off to the screen.
   Amber keeps meaning «your turn»; the only motion is the running dot (shared .orc-pulse). */
.orc-rp{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--orc-bg);color:var(--orc-fg);
  font:var(--dsw-font-xs-13,13px/20px system-ui,-apple-system,sans-serif)}
.orc-rp__head{flex:none;padding:12px 14px 10px;border-bottom:1px solid var(--orc-hair);background:var(--orc-layer1)}
.orc-rp__title{margin:0;font-size:15px;line-height:21px;font-weight:600;letter-spacing:-.01em;
  overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.orc-rp__sub{margin:2px 0 0;color:var(--orc-fg3);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}
.orc-rp__bind{margin-top:8px}
.orc-rp__scroll{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:14px;padding:12px}
.orc-rp__block{display:flex;flex-direction:column;gap:6px;min-width:0}
.orc-rp__label{display:flex;align-items:baseline;gap:6px;margin:0;padding:0 2px;color:var(--orc-fg2);
  font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif);text-transform:uppercase;letter-spacing:.03em}
.orc-rp__label--warn{color:var(--orc-warn)}
.orc-rp__list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.orc-rp__empty{padding:16px 14px;color:var(--orc-fg3)}
.orc-rp__lead{margin:6px 0 0;color:var(--orc-fg)}
.orc-rp__calm{margin:0;padding:0 2px;color:var(--orc-fg3);font:var(--dsw-font-xxs-12,12px/18px system-ui,sans-serif)}
.orc-rp__foot{flex:none;display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--orc-hair);background:var(--orc-layer1)}
.orc-rp__foot .orc-btn{flex:1 1 0}
.orc-rp__chip{font:inherit;color:inherit}

/* Sidebar icon: the badge counts everything waiting for the human, across repos and plans. The
   tokens here are raw — the sidebar is dsh's chrome, not .orc-root. */
.orc-icon{position:relative;display:inline-flex}
.orc-icon__badge{position:absolute;top:-6px;right:-8px;min-width:13px;height:13px;padding:0 3px;border-radius:999px;
  background:var(--dsw-alias-state-warn-primary,#f59e0b);color:#151517;
  font:700 9px/13px system-ui,-apple-system,sans-serif;text-align:center;
  box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base,#151517)}

/* Toasts: fixed under document.body so they can appear while the screen is closed. */
.orc-toasts{position:fixed;right:14px;bottom:14px;z-index:80;display:flex;flex-direction:column;gap:8px;
  width:min(360px,calc(100vw - 28px))}
.orc-toast{display:flex;flex-direction:column;gap:6px;padding:9px 10px 9px 12px;border:1px solid var(--orc-line);
  border-radius:12px;background:var(--orc-layer1);box-shadow:0 10px 30px #00000066;
  animation:orc-toast-in 200ms cubic-bezier(.23,1,.32,1) both}
@keyframes orc-toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.orc-toast__row{display:flex;align-items:flex-start;gap:7px}
.orc-toast__glyph{flex:none;color:var(--orc-warn);line-height:20px}
.orc-toast__text{flex:1 1 auto;min-width:0;color:var(--orc-fg);overflow-wrap:anywhere}
.orc-toast__x{flex:none;min-width:24px;min-height:24px;margin:-3px -4px -3px 0;padding:0;border:0;border-radius:6px;
  background:transparent;color:var(--orc-fg3);font-size:15px;line-height:1;cursor:pointer}
.orc-toast__x:hover{background:var(--orc-hover);color:var(--orc-fg)}
.orc-toast__acts{display:flex;justify-content:flex-end}

@media (prefers-reduced-motion:reduce){
  .orc-root,.orc-root *,.orc-settings *,.orc-toasts *,.orc-rp,.orc-rp *{animation:none!important;transition:none!important}
}
@media (prefers-contrast:more){
  .orc-root,.orc-settings,.orc-toasts,.orc-rp{--orc-hair:#ffffff45;--orc-line:#ffffff6b;--orc-fg3:var(--dsw-alias-label-secondary,#cfd3d6)}
  .orc-card,.orc-col,.orc-block,.orc-gnode__body,.orc-qrow,.orc-toast{border-color:var(--orc-line)}
  .orc-gnode--faded,.orc-gedge--off,.orc-gnode--dim,.orc-gedge--dim{opacity:.68}
  .orc-glane{border-color:var(--orc-fg3)}
}

/* Рабочие копии. Список копий в настройках. Размер выровнен по цифрам, чтобы столбец читался сверху вниз,
   а не пересчитывался глазами; причина уходит на свою строку, когда места на неё не хватает. */
.orc-worktrees__summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.orc-worktrees__summary>span{flex:1 1 auto;font-variant-numeric:tabular-nums}
.orc-worktrees button{min-height:26px;padding:3px 9px;border:1px solid var(--orc-line);border-radius:7px;background:var(--orc-layer2);color:var(--orc-fg2);font:inherit;cursor:pointer}
.orc-worktrees button:hover:not(:disabled){background:var(--orc-hover);color:var(--orc-fg)}
.orc-worktrees button:active:not(:disabled){transform:scale(.97)}
.orc-worktrees button:disabled{opacity:.5;cursor:default}
.orc-worktrees__list{margin-top:8px}
.orc-worktrees__item{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(110px,30%);align-items:center;gap:10px}
.orc-worktrees__path{display:flex;align-items:baseline;gap:4px;min-width:0}
.orc-worktrees__path code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px var(--orc-mono)}
.orc-worktrees__reason{color:var(--orc-fg3)}
.orc-worktrees__policy{display:flex;align-items:center;gap:8px;margin-top:10px;color:var(--orc-fg2)}
@media (max-width:900px){
  .orc-worktrees__item{grid-template-columns:minmax(0,1fr) auto}
  .orc-worktrees__reason{grid-column:1/-1}
}

/* First run */
.orc-root>.orc-welcome{grid-column:1/-1}
.orc-welcome{max-width:1050px;margin:0 auto;padding:clamp(28px,6vh,76px) 28px 60px;color:var(--orc-fg)}
.orc-welcome__hero{max-width:720px;margin-bottom:30px}
.orc-welcome__eyebrow{margin:0 0 12px;color:var(--orc-accent);font-size:11px;font-weight:700;letter-spacing:.13em;text-transform:uppercase}
.orc-welcome__hero h1{margin:0 0 12px;max-width:680px;font-size:clamp(26px,3vw,39px);line-height:1.12;letter-spacing:-.035em;font-weight:650}
.orc-welcome__hero>p:last-child{margin:0;color:var(--orc-fg2);font-size:15px;line-height:1.55}
.orc-welcome__grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start}
.orc-welcome__card{min-width:0;padding:22px;border:1px solid var(--orc-line);border-radius:14px;background:var(--orc-layer1)}
.orc-welcome__card h2{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0 0 17px;font-size:16px;line-height:1.3}
.orc-welcome__card h2 span{color:var(--orc-fg3);font-size:12px;font-weight:400}
.orc-welcome__checklist{list-style:none;display:grid;gap:0;margin:0;padding:0}
.orc-welcome__checklist li{display:grid;grid-template-columns:26px minmax(0,1fr);gap:11px;padding:15px 0;border-top:1px solid var(--orc-hair)}
.orc-welcome__checklist li:first-child{border-top:0;padding-top:0}
.orc-welcome__checklist strong{font-weight:600}
.orc-welcome__checklist p{margin:4px 0 6px;color:var(--orc-fg2);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.orc-welcome__checklist .orc-welcome__hint{margin:0 0 6px;color:var(--orc-fg3)}
.orc-welcome__ok,.orc-welcome__wait{display:grid;place-items:center;width:23px;height:23px;border-radius:50%;font-size:11px;font-weight:700}
.orc-welcome__ok{background:color-mix(in srgb,var(--orc-ok) 15%,transparent);color:var(--orc-ok)}
.orc-welcome__wait{border:1px solid var(--orc-line);color:var(--orc-fg3)}
.orc-welcome__card .orc-link{padding:0;border:0;background:none;color:var(--orc-accent);cursor:pointer;font:inherit;font-size:12px;text-align:left}
.orc-plans__badges>li{position:relative}
.orc-synthetic{margin:0;padding:6px 10px;border:1px dashed var(--orc-line);border-radius:6px;color:var(--orc-fg2);font-size:12px}
.orc-welcome__choice{width:100%;display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin:0 0 8px;padding:14px 16px;border:1px solid var(--orc-line);border-radius:9px;background:var(--orc-layer2);color:var(--orc-fg);text-align:left;cursor:pointer}
.orc-welcome__choice:hover{border-color:var(--orc-accent);background:var(--orc-hover)}
.orc-welcome__choice--primary{border-color:color-mix(in srgb,var(--orc-accent) 55%,transparent)}
.orc-welcome__choice strong{font-size:13px}
.orc-welcome__choice span{color:var(--orc-fg3);font-size:12px}
.orc-welcome__empty{display:flex;gap:8px;align-items:end;margin-top:19px;padding-top:18px;border-top:1px solid var(--orc-hair)}
.orc-welcome__empty label{flex:1;min-width:0;color:var(--orc-fg3);font-size:12px}
.orc-welcome__empty input{display:block;width:100%;margin-top:5px}
.orc-welcome__empty input,.orc-welcome__form input,.orc-welcome__form textarea,.orc-welcome__form select{padding:8px 10px;border:1px solid var(--orc-line);border-radius:6px;background:var(--orc-bg);color:var(--orc-fg);font:inherit}
.orc-welcome__empty button,.orc-welcome__form button{padding:8px 11px;border:1px solid var(--orc-line);border-radius:6px;background:var(--orc-layer2);color:var(--orc-fg);cursor:pointer;font:inherit}
.orc-welcome__hint{color:var(--orc-fg3);font-size:11px}
.orc-welcome__modal{position:fixed;inset:0;z-index:80;display:grid;place-items:center;padding:20px;background:#0009}
.orc-welcome__form{display:grid;gap:14px;width:min(480px,100%);padding:24px;border:1px solid var(--orc-line);border-radius:12px;background:var(--orc-layer1);box-shadow:0 16px 50px #0006}
.orc-welcome__form h2,.orc-welcome__form p{margin:0}
.orc-welcome__form label{display:grid;gap:5px;color:var(--orc-fg2);font-size:12px}
.orc-welcome__form textarea{min-height:90px;resize:vertical}
.orc-spec{width:min(560px,100%)}
.orc-spec__tabs{display:flex;gap:4px;padding:3px;border:1px solid var(--orc-line);border-radius:8px;background:var(--orc-bg)}
.orc-welcome__form .orc-spec__tab{flex:1;padding:6px 8px;border:0;border-radius:6px;background:none;color:var(--orc-fg2);font-size:12px}
.orc-welcome__form .orc-spec__tab[aria-selected=true]{background:var(--orc-layer2);color:var(--orc-fg);box-shadow:0 0 0 1px var(--orc-line)}
.orc-spec__drop{display:grid;gap:10px;justify-items:start;padding:18px;border:1.5px dashed var(--orc-line);border-radius:10px;background:var(--orc-bg)}
.orc-spec__drop--over,.orc-welcome__choice--drop{border-color:var(--orc-accent);background:color-mix(in srgb,var(--orc-accent) 10%,var(--orc-bg))}
.orc-spec__drop p{margin:0;overflow-wrap:anywhere}
.orc-welcome__form textarea.orc-spec__paste{min-height:180px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px}
.orc-welcome__form select[size]{padding:4px}
.orc-welcome__form .orc-spec__submit:disabled{opacity:.5;cursor:default}
.orc-welcome__form>div:last-child{display:flex;gap:8px}
.orc-tour{position:fixed;z-index:65;width:min(320px,calc(100vw - 28px));padding:16px;border:1px solid var(--orc-accent);border-radius:11px;background:var(--orc-layer2);box-shadow:0 10px 35px #0008;color:var(--orc-fg)}
.orc-tour p{margin:0 0 14px}.orc-tour__count{color:var(--orc-accent);font-size:11px;font-weight:700}
.orc-tour__actions{display:flex;gap:6px;align-items:center;justify-content:flex-start}
.orc-tour__actions button{flex:none;width:auto;padding:5px 11px;border:1px solid var(--orc-line);border-radius:6px;background:var(--orc-layer2);color:var(--orc-fg);cursor:pointer;font:inherit;font-size:12px;line-height:18px}
.orc-tour__actions .orc-tour__primary{border-color:var(--orc-accent);background:color-mix(in srgb,var(--orc-accent) 22%,var(--orc-layer2));font-weight:600}
.orc-tour__actions .orc-tour__skip{margin-left:auto;padding:5px 4px;border:0;background:none;color:var(--orc-fg3)}
.orc-tour__actions .orc-tour__skip:hover{color:var(--orc-fg);text-decoration:underline}
[data-tour-target]{outline:2px solid var(--orc-accent)!important;outline-offset:3px;border-radius:8px;box-shadow:0 0 0 7px color-mix(in srgb,var(--orc-accent) 22%,transparent)!important;transition:outline-offset .2s,box-shadow .2s}
@media(max-width:1100px){.orc-welcome{padding:30px 20px 50px}.orc-welcome__grid{gap:12px}.orc-welcome__card{padding:17px}}
@media(max-width:760px){.orc-welcome__grid{grid-template-columns:1fr}.orc-welcome__hero h1{font-size:29px}}
@media(prefers-reduced-motion:reduce){.orc-tour,[data-tour-target],.orc-welcome *{scroll-behavior:auto;transition:none!important;animation:none!important}}
.orc-task-menu{position:fixed;z-index:1000;width:min(310px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;padding:6px;border:1px solid var(--orc-line);border-radius:12px;background:var(--orc-layer2);color:var(--orc-fg);box-shadow:0 16px 44px #0008;font-size:13px}
.orc-task-menu__group+.orc-task-menu__group{border-top:1px solid var(--orc-sep);margin-top:5px;padding-top:5px}
.orc-task-menu [role=menuitem]{display:block;width:100%;border:0;border-radius:6px;padding:8px 10px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
.orc-task-menu [role=menuitem]:hover,.orc-task-menu [role=menuitem]:focus-visible{background:var(--orc-active);outline:none}
.orc-task-menu__form{display:grid;gap:9px;padding:8px}
.orc-task-menu__form label{display:grid;gap:4px;color:var(--orc-fg2)}
.orc-task-menu__form label:has([type=checkbox]){display:flex;align-items:center}
.orc-task-menu__form input:not([type=checkbox]),.orc-task-menu__form textarea,.orc-task-menu__form select{box-sizing:border-box;width:100%;border:1px solid var(--orc-line);border-radius:6px;padding:7px;background:var(--orc-layer1);color:var(--orc-fg);font:inherit}
.orc-task-menu__form textarea{min-height:75px;resize:vertical}
.orc-task-menu__buttons{display:flex;gap:7px}
.orc-task-menu__buttons button{border:1px solid var(--orc-line);border-radius:6px;padding:7px 11px;background:var(--orc-layer1);color:var(--orc-fg);cursor:pointer}
.orc-task-menu__buttons button:first-child{background:var(--orc-accent-strong);color:#fff}
.orc-root [data-task-id][data-multiselect=true]{outline:2px solid var(--orc-accent)!important;outline-offset:2px}
@media(prefers-reduced-motion:reduce){.orc-task-menu *{transition:none!important;animation:none!important}}
`

/**
 * Keeps one stylesheet per document and brings it up to date: dsh reloads a plugin without reloading
 * the page, and a tag left by the previous build would keep its old rules next to the new markup.
 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  const existing = document.querySelector<HTMLStyleElement>('style[data-orchestra]')
  if (existing) {
    if (existing.textContent !== CSS) existing.textContent = CSS
    return
  }
  const style = document.createElement('style')
  style.setAttribute('data-orchestra', '')
  style.textContent = CSS
  document.head.append(style)
}

export type StatusTone = { label: string; glyph: string; color: string }

const STATUS_COLOR: Record<ViewStatus, string> = {
  backlog: 'var(--orc-fg3)',
  ready: 'var(--orc-accent)',
  running: 'var(--orc-accent-strong)',
  in_review: 'var(--orc-warn)',
  accepted: 'var(--orc-ok)',
  closed: 'var(--orc-fg3)',
  blocked: 'var(--orc-fg3)',
  superseded: 'var(--orc-fg3)',
  dropped: 'var(--orc-fg3)',
}

/** Single status table for every view: never colour alone — a glyph and a word always come with it. */
export function statusTone(status: ViewStatus): StatusTone {
  return { label: STATUS_LABEL[status], glyph: STATUS_GLYPH[status], color: STATUS_COLOR[status] }
}

/** Human decisions keep the ◆ of the spec whatever their status. */
export function taskTone(task: { status: ViewStatus; kind: string; closed?: 'negative'; check?: CheckState; byOrchestrator?: true; preparing?: true }): StatusTone {
  if (task.closed === 'negative') return { label: t('status.closedNegative'), glyph: '○', color: 'var(--orc-fg3)' }
  // Finished work the orchestrator is still checking: calm, not yet the person's turn (vr1).
  if (task.status === 'in_review' && isChecking(task.check)) return { label: t('status.checking'), glyph: '◌', color: 'var(--orc-fg2)' }
  // A decision the orchestrator still prepares (rt1): calm too, not yet the person's turn.
  if (task.preparing) return { label: t('status.preparing'), glyph: '◆', color: 'var(--orc-fg2)' }
  const tone = statusTone(task.status)
  // The orchestrator's own work (rt1) keeps ▣ whatever its status, like ◆ for decisions.
  if (task.kind === 'root') return { ...tone, glyph: '▣', ...(task.byOrchestrator ? { label: t('status.byOrchestrator') } : {}) }
  return task.kind === 'decision' ? { ...tone, glyph: '◆' } : tone
}
