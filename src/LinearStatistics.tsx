import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Event = { id: string; topic: string; answered_at: string; correct: boolean; mode: string; question: string; image_url: string; help: Record<string,string>; answers: {letter:string;text:string;correct:boolean;selected:boolean}[] };
type TopicRow = { topic: string; correct: number; wrong: number };
type TimelinePage = { events: Event[]; total: number; correct: number; has_more: boolean };
type TopicsPage = { rows: TopicRow[]; total: number; has_more: boolean; days: string[] };
const ratio = (n:number,total:number) => total ? `${(100*n/total).toLocaleString('ru-RU',{maximumFractionDigits:1})}%` : '0%';

// Each panel requests its own pages; totals always cover the complete query.
function usePages<T extends {total:number;has_more:boolean},R>(query:string,items:(page:T)=>R[]) {
 const [state,setState]=useState<{key:string;page:T|null;rows:R[];loading:boolean;error:string}>({key:'',page:null,rows:[],loading:false,error:''});
 const [retry,setRetry]=useState(0);
 const pending=useRef(false);
 const generation=useRef(query);
 useEffect(()=>{
  const controller=new AbortController();generation.current=query;pending.current=true;
  fetch(`${query}&offset=0`,{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(async r=>{if(!r.ok)throw Error();return await r.json() as T;}).then(page=>{
   setState({key:query,page,rows:items(page),loading:false,error:''});
  }).catch(()=>{if(!controller.signal.aborted)setState({key:query,page:null,rows:[],loading:false,error:'Не удалось загрузить статистику.'});}).finally(()=>{if(generation.current===query)pending.current=false;});
  return()=>controller.abort();
 },[query,items,retry]);
 async function more(){
  if(pending.current||state.key!==query)return;
  if(!state.page){setRetry(n=>n+1);return;}
  if(!state.page.has_more)return;
  pending.current=true;setState(s=>({...s,loading:true,error:''}));
  try {
   const response=await fetch(`${query}&offset=${state.rows.length}`,{credentials:'same-origin',cache:'no-store'});
   if(!response.ok)throw Error();const page=await response.json() as T;
   if(generation.current===query)setState(s=>({...s,page,rows:[...s.rows,...items(page)],loading:false,error:''}));
  }catch{if(generation.current===query)setState(s=>({...s,loading:false,error:'Не удалось загрузить следующую страницу.'}));}
  finally{if(generation.current===query)pending.current=false;}
 }
 return {page:state.key===query?state.page:null,rows:state.key===query?state.rows:[],loading:state.key!==query||state.loading,error:state.key===query?state.error:'',more};
}
const timelineItems=(page:TimelinePage)=>page.events;
const topicItems=(page:TopicsPage)=>page.rows;
function Loading(){return <div className="statistics-loading" role="status"><span className="page-spinner"/><span className="sr-only">Загрузка статистики</span></div>;}

const dayKey=(date:Date)=>date.toISOString().slice(0,10);
function MonthCalendar({days,range,onChange}:{days:string[];range:{from:string;to:string}|null;onChange:(range:{from:string;to:string}|null)=>void}) {
 const [open,setOpen]=useState(false);
 const [month,setMonth]=useState(()=>new Date().toISOString().slice(0,7));
 const [position,setPosition]=useState({left:12,top:12});
 const root=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(!open)return;const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};},[open]);
 const first=new Date(`${month}-01T00:00:00Z`);
 const end=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0));
 const start=new Date(first);start.setUTCDate(start.getUTCDate()-((start.getUTCDay()+6)%7));
 const weeks=Array.from({length:Math.ceil((((first.getUTCDay()+6)%7)+end.getUTCDate())/7)},(_,week)=>Array.from({length:7},(_,day)=>new Date(start.getTime()+(week*7+day)*86400000)));
 const available=new Set(days);
 function move(delta:number){setMonth(dayKey(new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+delta,1))).slice(0,7));}
 function select(from:string,to:string){onChange({from,to});setOpen(false);}
 const label=range?range.from.slice(0,7)===range.to.slice(0,7)&&range.from.endsWith('-01')&&range.to===dayKey(new Date(Date.UTC(Number(range.from.slice(0,4)),Number(range.from.slice(5,7)),0)))?new Date(`${range.from}T00:00:00Z`).toLocaleDateString('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'}):`${range.from.split('-').reverse().join('.')} — ${range.to.split('-').reverse().join('.')}`:'За всё время';
 return <div className="statistics-calendar" ref={root}><button className="calendar-trigger" aria-expanded={open} onClick={()=>{if(!open){setMonth(range?.from.slice(0,7)||days[0]?.slice(0,7)||month);const rect=root.current!.getBoundingClientRect();setPosition({left:Math.max(12,Math.min(rect.right-280,window.innerWidth-292)),top:Math.max(12,Math.min(rect.bottom+8,window.innerHeight-310))});}setOpen(!open);}}>▦ {label}</button>{open&&<div className="calendar-popover" style={position}><header><button aria-label="Предыдущий месяц" onClick={()=>move(-1)}>‹</button><button className="calendar-month" title="Выбрать весь месяц" onClick={()=>select(dayKey(first),dayKey(end))}>{first.toLocaleDateString('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'})}</button><button aria-label="Следующий месяц" onClick={()=>move(1)}>›</button></header><div className="calendar-weekdays">{['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d=><span key={d}>{d}</span>)}</div>{weeks.map(week=><button className="calendar-week" key={dayKey(week[0])} title="Выбрать неделю" aria-label={`Неделя с ${dayKey(week[0])} по ${dayKey(week[6])}`} onClick={()=>select(dayKey(week[0]),dayKey(week[6]))}>{week.map(date=>{const key=dayKey(date);return <span key={key} className={`${key.slice(0,7)!==month?'outside':''} ${available.has(key)?'has-answers':''} ${range&&key>=range.from&&key<=range.to?'selected':''}`}>{date.getUTCDate()}</span>;})}</button>)}<footer><span>Нажмите на месяц или неделю</span><button onClick={()=>{onChange(null);setOpen(false);}}>Всё время</button></footer></div>}</div>;
}

export function LinearStatistics({onBack}:{onBack:()=>void}) {
 const [questionsOpen,setQuestionsOpen]=useState(true);
 const [topicsOpen,setTopicsOpen]=useState(true);
 const [groupMonths,setGroupMonths]=useState(true);
 const [filters,setFilters]=useState({correct:false,wrong:true});
 const [sort,setSort]=useState<{column:'correct'|'wrong';direction:'asc'|'desc'}>({column:'wrong',direction:'desc'});
 const [range,setRange]=useState<{from:string;to:string}|null>(null);
 const filter=filters.correct&&filters.wrong?'all':filters.wrong?'errors':'perfect';
 const timeline=usePages<TimelinePage,Event>('/api/statistics/linear?paged=1',timelineItems);
 const topicQuery=`/api/statistics/topics?filter=${filter}&sort=${sort.column}&direction=${sort.direction}${range?`&from=${range.from}&to=${range.to}`:''}`;
 const topics=usePages<TopicsPage,TopicRow>(topicQuery,topicItems);
 const [active,setActive]=useState<{event:Event;left:number;top:number;number:number}|null>(null);
 const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const popup=useRef<HTMLDivElement>(null);
 const trigger=useRef<HTMLButtonElement|null>(null);
 useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
 useEffect(()=>{if(!active)return;const close=(e:KeyboardEvent)=>{if(e.key==='Escape'){trigger.current?.focus();setActive(null);}};const outside=(e:PointerEvent)=>{if(!popup.current?.contains(e.target as Node)&&!trigger.current?.contains(e.target as Node))setActive(null);};const resized=()=>setActive(null);document.addEventListener('keydown',close);document.addEventListener('pointerdown',outside);window.addEventListener('resize',resized);return()=>{document.removeEventListener('keydown',close);document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',resized);};},[active]);
 function keep(){if(timer.current)clearTimeout(timer.current);}
 function later(){keep();timer.current=setTimeout(()=>setActive(null),220);}
 function show(event:Event,index:number,button:HTMLButtonElement){keep();trigger.current=button;const r=button.getBoundingClientRect();setActive({event,number:index+1,left:Math.max(12,Math.min(r.left,window.innerWidth-Math.min(560,window.innerWidth-24)-12)),top:Math.max(12,Math.min(r.bottom+8,window.innerHeight-340))});}
 function loadOnScroll(e:React.UIEvent<HTMLDivElement>,more:()=>void){setActive(null);if(e.currentTarget.scrollHeight-e.currentTarget.scrollTop-e.currentTarget.clientHeight<150)void more();}
 function sortBy(column:'correct'|'wrong'){setSort(current=>({column,direction:current.column===column&&current.direction==='desc'?'asc':'desc'}));}
 function toggleFilter(key:'correct'|'wrong'){setFilters(current=>current[key]&&!current[key==='correct'?'wrong':'correct']?current:{...current,[key]:!current[key]});}
 return <main className="statistics-page"><header className="statistics-page-header"><button className="statistics-back library-back" onClick={onBack}>‹ Панель обучения</button><h1>Статистика</h1></header><div className="statistics-panels">
  <section className={`statistics-panel ${questionsOpen?'expanded':'collapsed'}`}><div className="statistics-panel-heading"><button className="statistics-accordion" aria-expanded={questionsOpen} aria-controls="question-statistics" onClick={()=>{setActive(null);setQuestionsOpen(!questionsOpen);}}><span>{questionsOpen?'⌄':'›'}</span><h2>По вопросам</h2></button>{questionsOpen&&<label className="month-group-toggle"><input type="checkbox" checked={groupMonths} onChange={e=>setGroupMonths(e.target.checked)}/>По месяцам</label>}</div>{questionsOpen&&<><p className="linear-summary" aria-live="polite">Вопросов: {timeline.page?.total??'…'} · <span className="linear-good-text">Верно: {ratio(timeline.page?.correct??0,timeline.page?.total??0)} ({timeline.page?.correct??0})</span> · <span className="linear-bad-text">Неверно: {ratio((timeline.page?.total??0)-(timeline.page?.correct??0),timeline.page?.total??0)} ({(timeline.page?.total??0)-(timeline.page?.correct??0)})</span></p><div id="question-statistics" className="statistics-scroll question-statistics-scroll" tabIndex={0} aria-label="История вопросов" onScroll={e=>loadOnScroll(e,timeline.more)}>{timeline.rows.map((event,index)=>{const month=new Date(event.answered_at).toLocaleDateString('ru-RU',{month:'long',year:'numeric'});const previous=index?new Date(timeline.rows[index-1].answered_at).toLocaleDateString('ru-RU',{month:'long',year:'numeric'}):'';return <div key={event.id}>{groupMonths&&month!==previous&&<h3 className="statistics-month-heading">{month}</h3>}<button className={`linear-chip statistics-question-row ${event.correct?'passed':'failed'}`} aria-label={`${index+1}. ${event.topic}. ${event.correct?'Верно':'Неверно'}`} aria-haspopup="dialog" aria-expanded={active?.event.id===event.id} onMouseEnter={e=>show(event,index,e.currentTarget)} onMouseLeave={later} onFocus={e=>show(event,index,e.currentTarget)} onBlur={e=>{if(!popup.current?.contains(e.relatedTarget as Node))later();}} onClick={e=>show(event,index,e.currentTarget)}><b>{index+1}</b><time dateTime={event.answered_at}>{new Date(event.answered_at).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'})}</time><span>{event.topic}</span><i aria-hidden="true">{event.correct?'✓':'×'}</i></button></div>;})}{timeline.loading&&<Loading/>}{timeline.error&&<p role="alert">{timeline.error} <button onClick={()=>void timeline.more()}>Повторить</button></p>}{!timeline.loading&&!timeline.error&&!timeline.rows.length&&<p>Пока нет сохранённых ответов.</p>}</div></>}
  </section>
  <section className={`statistics-panel ${topicsOpen?'expanded':'collapsed'}`}><div className="statistics-panel-heading"><button className="statistics-accordion" aria-expanded={topicsOpen} aria-controls="topic-statistics" onClick={()=>setTopicsOpen(!topicsOpen)}><span>{topicsOpen?'⌄':'›'}</span><h2>По темам</h2></button>{topicsOpen&&<MonthCalendar days={topics.page?.days??[]} range={range} onChange={setRange}/>}</div>{topicsOpen&&<><div className="statistics-segmented" role="group" aria-label="Фильтр тем"><button aria-pressed={filters.correct} className={`correct ${filters.correct?'selected':''}`} onClick={()=>toggleFilter('correct')}>Правильно</button><button aria-pressed={filters.wrong} className={`wrong ${filters.wrong?'selected':''}`} onClick={()=>toggleFilter('wrong')}>С ошибками</button></div><div key={topicQuery} id="topic-statistics" className="statistics-scroll statistics-topic-scroll" tabIndex={0} aria-label="Результаты по темам" onScroll={e=>loadOnScroll(e,topics.more)}><table><thead><tr><th scope="col">Тема</th>{(['correct','wrong'] as const).map(column=><th scope="col" key={column} aria-sort={sort.column===column?sort.direction==='desc'?'descending':'ascending':'none'}><button onClick={()=>sortBy(column)}>{column==='correct'?'Верно':'Неверно'} <span>{sort.column===column?sort.direction==='desc'?'↓':'↑':'↕'}</span></button></th>)}</tr></thead><tbody>{topics.rows.map(row=><tr key={row.topic}><th scope="row">{row.topic}</th><td className="linear-good-text">{ratio(row.correct,row.correct+row.wrong)} <small>({row.correct})</small></td><td className="linear-bad-text">{ratio(row.wrong,row.correct+row.wrong)} <small>({row.wrong})</small></td></tr>)}</tbody></table>{topics.loading&&<Loading/>}{topics.error&&<p role="alert">{topics.error} <button onClick={()=>void topics.more()}>Повторить</button></p>}{!topics.loading&&!topics.error&&!topics.rows.length&&<p>Нет тем для выбранного фильтра.</p>}</div></>}
  </section>
 </div>{active&&createPortal(<div ref={popup} role="dialog" aria-label={`Ответ ${active.number}`} className="linear-popover" style={{left:active.left,top:active.top,maxHeight:`calc(100dvh - ${active.top+12}px)`}} onMouseEnter={keep} onMouseLeave={later} onFocus={keep} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))later();}}><header><div><time dateTime={active.event.answered_at}>{new Date(active.event.answered_at).toLocaleString('ru-RU')}</time><p>{active.event.topic}{active.event.mode==='mistakes'?' · Работа над ошибками':''}</p></div><button aria-label="Закрыть вопрос" onClick={()=>{trigger.current?.focus();setActive(null);}}>×</button></header>{active.event.image_url&&<img src={active.event.image_url} alt="Иллюстрация вопроса"/>}<h3>{active.event.question}</h3><div className="linear-answers">{active.event.answers.map(a=><div key={a.letter} className={`linear-answer ${a.correct?'right':a.selected?'wrong':''}`}><b>{a.letter}</b><span>{a.text}{a.selected&&<small>Ваш ответ</small>}</span><strong>{a.correct?'✓':a.selected?'×':''}</strong></div>)}</div><p className={active.event.correct?'linear-good-text':'linear-bad-text'}>{active.event.correct?'✓ Верно':'× Неверно'}</p>{active.event.help?.en&&<details><summary>Объяснение</summary><p className="linear-help">{active.event.help.ru||active.event.help.en}</p></details>}</div>,document.body)}</main>;
}

export function ReleaseDetails(){
 const version=import.meta.env.VITE_APP_VERSION||'dev';
 const [releases,setReleases]=useState<{version:string;deployed_at:string|null;changes:string[]}[]>([]);
 useEffect(()=>{let live=true;fetch('/api/releases',{cache:'no-store'}).then(r=>r.ok?r.json():[]).then(data=>{if(live)setReleases(data);}).catch(()=>undefined);return()=>{live=false;};},[]);
 const release=releases.find(r=>r.version===version) || (version==='dev'?releases.find(r=>!r.deployed_at):undefined);
 return <span className="release-details" tabIndex={0} aria-label={`Версия приложения ${version}`}><span className="app-version">{version}</span><span className="release-tooltip" role="tooltip"><strong>Версия {version}</strong><time>{release?.deployed_at?new Date(release.deployed_at).toLocaleString('ru-RU'):version==='dev'?'Локальная версия':'Дата публикации пока недоступна'}</time>{release?.changes?.length?<ul>{release.changes.map(c=><li key={c}>{c}</li>)}</ul>:null}</span></span>;
}
