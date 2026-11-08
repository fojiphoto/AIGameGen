export type World = 'fortress' | 'forest' | 'graveyard';
export type EnemyKind = 'walker' | 'swordsman' | 'guardian' | 'raven' | 'plant' | 'mage' | 'boss';
export type Phase = 'playing' | 'dead' | 'complete';
export interface Rect { x:number; y:number; w:number; h:number }
export interface Input { left:boolean; right:boolean; jump:boolean; jumpHeld:boolean; attack:boolean; attackHeld:boolean; dash:boolean; special:boolean; down:boolean; sprint:boolean }
export const emptyInput = ():Input => ({left:false,right:false,jump:false,jumpHeld:false,attack:false,attackHeld:false,dash:false,special:false,down:false,sprint:false});
export interface Platform extends Rect { kind:'stone'|'wood'|'moving'|'crumble'; baseX?:number; baseY?:number; range?:number; speed?:number; timer?:number; disabled?:boolean }
export interface Hazard extends Rect { kind:'spikes'|'blade'; phase?:number }
export interface EnemySpawn { kind:EnemyKind; x:number; y:number }
export interface Pickup { id:number; x:number; y:number; kind:'coin'|'gem'|'heart'|'energy'; taken:boolean }
export interface Prop extends Rect { id:number; kind:'crate'|'urn'|'lever'|'gate'; hp:number; active:boolean; link?:number }
export interface Checkpoint { x:number; y:number; active:boolean }
export interface Level { id:number; name:string; subtitle:string; world:World; width:number; spawn:{x:number;y:number}; platforms:Platform[]; hazards:Hazard[]; enemies:EnemySpawn[]; pickups:Pickup[]; props:Prop[]; checkpoints:Checkpoint[]; exit:{x:number;y:number}; parTime:number; tip:string }
export interface Actor extends Rect { vx:number; vy:number; facing:number; grounded:boolean; hp:number; maxHp:number; invulnerable:number; animation:string; animTime:number }
export interface Player extends Actor { energy:number; maxEnergy:number; dashCooldown:number; dashTime:number; attackTime:number; attackDuration:number; combo:number; attackKind:'normal'|'air'|'charged'|'dash'|'special'; charge:number; jumps:number; coyote:number; jumpBuffer:number; hitIds:Set<number>; attackId:number; landing:number }
export interface Enemy extends Actor { id:number; kind:EnemyKind; state:string; timer:number; cooldown:number; homeX:number; homeY:number; stun:number; phase:number; attackCount:number; deadTime:number }
export interface Projectile extends Rect { id:number; vx:number; vy:number; life:number; friendly:boolean; damage:number; kind:'orb'|'wave' }
export interface GameEvent { type:'jump'|'land'|'slash'|'hit'|'block'|'kill'|'hurt'|'dash'|'coin'|'gem'|'heart'|'checkpoint'|'break'|'special'|'boss'|'complete'|'death'|'hint'; x:number; y:number; facing?:number; value?:number; kind?:string; text?:string }
export interface Upgrades { health:number; sword:number; focus:number }
export interface Settings { music:number; sfx:number; shake:boolean; quality:'low'|'high'; touch:boolean }
export interface SaveData { version:1; unlocked:number; stars:number[]; wallet:number; upgrades:Upgrades; weapon:string; weapons:string[]; settings:Settings; tutorial:boolean; bestTimes:number[] }
export interface RunStats { coins:number; gems:number; kills:number; time:number; deaths:number; damageTaken:number }
export interface SessionView { level:Level; player:Player; enemies:Enemy[]; pickups:Pickup[]; props:Prop[]; platforms:Platform[]; hazards:Hazard[]; checkpoints:Checkpoint[]; projectiles:Projectile[]; phase:Phase; stats:RunStats; events:GameEvent[]; time:number; hitStop:number; checkpoint:{x:number;y:number}; bossActive:boolean; hint:string }
