export const NS = 'valda-gunslinger-zh';
export const PACK = `world.${NS}`;
const keyOf = item => item?.flags?.[NS]?.key;
const find = (actor, key) => actor?.items.find(i => keyOf(i) === key);
const levelOf = actor => Number(actor?.classes?.gunslinger?.system.levels ?? 0);
export const criticalAt = level => level >= 17 ? 17 : level >= 9 ? 18 : level >= 2 ? 19 : 20;
export const rangeAt = level => { const tier = level >= 17 ? 3 : level >= 11 ? 2 : level >= 5 ? 1 : 0; return {value:60+30*tier,long:240+120*tier,units:'ft'}; };
const compatible = () => game.system.id === 'dnd5e' && game.system.version === '5.3.3' && Number(game.release.generation) === 13;

let installPromise;
export function install() {
  if (installPromise) return installPromise;
  installPromise = installImpl().finally(() => { installPromise = undefined; });
  return installPromise;
}
async function installImpl() {
  if (!game.user.isGM) throw new Error('請由GM匯入彙編。');
  if (!compatible()) throw new Error('此包限 FVTT 13／D&D5e 5.3.3。');
  const response = await fetch(`modules/${NS}/items.json`);
  if (!response.ok) throw new Error(`讀取職業資料失敗：${response.status}`);
  const data = await response.json();
  // Validate with the user's real system before writing anything.
  for (const raw of data) {
    const test = new Item(raw, {strict:true});
    test.validate({strict:true});
  }
  let pack = game.packs.get(PACK);
  if (pack && pack.documentName !== 'Item') throw new Error('同名彙編不是Item類型；停止匯入。');
  if (!pack) pack = await CompendiumCollection.createCompendium({name:NS,label:'銃士與魔彈客（繁中）',type:'Item'});
  const existing = await pack.getDocuments();
  for (const raw of data) {
    const other = existing.find(i => i.id === raw._id);
    if (other && keyOf(other) !== raw.flags[NS].key) throw new Error('彙編ID衝突，未覆寫既有資料。');
  }
  const locked = pack.locked;
  try {
    if (locked) await pack.configure({locked:false});
    const missing = data.filter(d => !existing.some(e => e.id === d._id));
    if (missing.length) await Item.createDocuments(missing, {pack:PACK,keepId:true});
    const final = await pack.getDocuments();
    if (!data.every(d => final.some(i => i.id === d._id))) throw new Error('彙編匯入不完整；可重試補齊。');
    await game.settings.set(NS,'installed',true);
    const command = `await game.modules.get('${NS}').api.checkSelected();`;
    if (!game.macros.some(m => m.getFlag(NS,'check'))) await Macro.create({
      name:'銃士：檢查與同步角色',type:'script',img:'icons/svg/target.svg',command,flags:{[NS]:{check:true}}
    });
    ui.notifications.info(`銃士與魔彈客已匯入，共 ${data.length} 項。請從彙編拖曳職業，再於3級加入子職。`);
    return pack;
  } finally { if (locked) await pack.configure({locked:true}); }
}

export async function syncActor(actor) {
  if (!actor?.isOwner || !find(actor,'gunslinger')) return;
  const risk = find(actor,'gunslinger-risk');
  const updates=[];
  for (const item of actor.items) {
    if (!keyOf(item)) continue;
    const update={_id:item.id};
    for (const activity of item.system.activities ?? []) {
      const cost=activity.flags?.[NS]?.risk;
      if (!cost || item === risk || !risk) continue;
      const target={type:'itemUses',target:risk.id,value:String(cost),scaling:{mode:'',formula:''}};
      const targets=activity.consumption.targets;
      if (targets.length!==1 || targets[0].target!==risk.id || targets[0].value!==String(cost)) {
        update[`system.activities.${activity.id}.consumption.targets`]=[target];
      }
    }
    if (keyOf(item)==='spellslinger-finger-weapon') {
      const total=Number(actor.system.details.level ?? levelOf(actor));
      const range=rangeAt(total);
      if (item.system.range.value!==range.value || item.system.range.long!==range.long || item.system.range.units!=='ft') update['system.range']=range;
    }
    if (Object.keys(update).length>1) updates.push(update);
  }
  if (updates.length) await actor.updateEmbeddedDocuments('Item',updates,{valdaSync:true});
}
const queued=new Map();
function schedule(actor,options={},userId) {
  if (!actor || options.valdaSync || userId!==game.user.id || !actor.isOwner) return;
  clearTimeout(queued.get(actor.uuid));
  queued.set(actor.uuid,setTimeout(()=>{
    queued.delete(actor.uuid);
    syncActor(actor).catch(e=>{console.error(NS,e);ui.notifications.error('銃士資源連結失敗，請執行檢查巨集。');});
  },150));
}

export function applyCritical(config) {
  const activity=config.subject, actor=activity?.actor;
  if (!find(actor,'gunslinger-critical-shot') || activity?.attack?.type.value!=='ranged' || activity?.attack?.type.classification!=='weapon') return;
  const threshold=criticalAt(levelOf(actor));
  for (const roll of config.rolls ?? []) {
    roll.options ??= {};
    roll.options.criticalSuccess=Math.min(roll.options.criticalSuccess ?? 20,threshold);
  }
}

function checkResourceLink(activity) {
  const cost=activity.flags?.[NS]?.risk;
  if (!cost) return;
  const risk=find(activity.actor,'gunslinger-risk');
  if (!risk) { ui.notifications.warn('角色缺少風險骰資源。'); return false; }
  const target=activity.consumption.targets.find(t=>t.type==='itemUses');
  const correct=activity.item.id===risk.id ? target?.target==='' : target?.target===risk.id;
  if (!correct) { schedule(activity.actor,{},game.user.id);ui.notifications.warn('正在連結風險骰，請稍後重按。');return false; }
  if (activity.flags[NS].resetHeadshot && activity.item.system.uses.spent===0) {ui.notifications.warn('爆頭尚未消耗，不需要重置。');return false;}
}
export function resourceUpdates(activity,config,_message,updates) {
  const flags=activity.flags?.[NS];
  if (!flags || config.consume===false) return;
  const actor=activity.actor;
  if (flags.restoreRisk) {
    if (levelOf(actor)<15) return false;
    const risk=find(actor,'gunslinger-risk');
    if (!risk) return false;
    updates.item.push({_id:risk.id,'system.uses.spent':Math.max(0,risk.system.uses.spent-1)});
  }
  if (flags.resetHeadshot) {
    const risk=find(actor,'gunslinger-risk');
    // Reset only if the native consumption actually deducted the three dice.
    const delta=updates.item.find(i=>i._id===risk?.id);
    const spent=delta?.['system.uses.spent'] ?? delta?.system?.uses?.spent;
    if (spent!==risk?.system.uses.spent+3) {ui.notifications.warn('需勾選消耗3枚風險骰才能重置。');return false;}
    updates.item.push({_id:activity.item.id,'system.uses.spent':0});
  }
}

export async function checkSelected() {
  const selected=canvas.tokens.controlled;
  const actor=selected.length===1 ? selected[0].actor : selected.length===0 ? game.user.character : null;
  if (!actor) return ui.notifications.warn('請選取一個Token，或指定自己的角色。');
  await syncActor(actor);
  const cls=find(actor,'gunslinger'), sub=find(actor,'spellslinger'), risk=find(actor,'gunslinger-risk');
  if (!cls) return ui.notifications.warn('角色尚未加入本包的銃士職業。');
  const level=levelOf(actor), issues=[];
  if (level>=2&&!risk) issues.push('缺少風險骰：請補跑職業升級流程。');
  if (level>=3&&!sub) issues.push('尚未加入魔彈客。');
  if (sub && sub.system.classIdentifier!=='gunslinger') issues.push('子職關聯錯誤。');
  const esc=foundry.utils.escapeHTML;
  const html=`<h3>${esc(actor.name)}：銃士 ${level} 級</h3><p>風險骰：${risk ? `${risk.system.uses.value}/${risk.system.uses.max}`:'未取得'}；遠程武器重擊門檻：${criticalAt(level)}。</p><p>子職：${sub?'魔彈客／智力／三分之一施法':'未加入'}。</p><p>${issues.length?issues.map(esc).join('<br>'):'基本連結檢查通過。此檢查不代表所有戰鬥模組組合已驗證。'}</p><p>條件性能力、法術選擇、裝備與目標效果請依說明手動判定。</p>`;
  await ChatMessage.create({content:html,whisper:[game.user.id]});
}

Hooks.once('init',()=>game.settings.register(NS,'installed',{scope:'world',config:false,type:Boolean,default:false}));
Hooks.once('ready',()=>{
  game.modules.get(NS).api={install,syncActor,checkSelected};
  if (!compatible()) { if(game.user.isGM)ui.notifications.warn('銃士模組僅針對 FVTT 13／D&D5e 5.3.3；輔助功能未啟動。');return; }
  Hooks.on('createItem',(item,options,userId)=>schedule(item.actor,options,userId));
  Hooks.on('updateItem',(item,_changes,options,userId)=>schedule(item.actor,options,userId));
  Hooks.on('deleteItem',(item,options,userId)=>schedule(item.actor,options,userId));
  Hooks.on('updateActor',(actor,_changes,options,userId)=>schedule(actor,options,userId));
  Hooks.on('dnd5e.preRollAttack',applyCritical);
  Hooks.on('dnd5e.preUseActivity',checkResourceLink);
  Hooks.on('dnd5e.activityConsumption',resourceUpdates);
  const gm=game.users.activeGM;
  if(game.user.isGM && (!gm || gm.id===game.user.id) && !game.settings.get(NS,'installed')) {
    new Dialog({title:'匯入銃士與魔彈客',content:'<p>建立此世界專用的職業彙編與檢查巨集。完成後從彙編拖入角色。既有同ID資料不覆寫。</p>',buttons:{yes:{label:'建立彙編',callback:()=>install().catch(e=>{console.error(NS,e);ui.notifications.error(e.message);})},no:{label:'稍後'}},default:'yes'}).render(true);
  }
});
