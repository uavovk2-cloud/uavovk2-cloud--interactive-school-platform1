const $ = id => document.getElementById(id);
let teacher = JSON.parse(localStorage.getItem('teacherSession') || 'null');
let student = JSON.parse(localStorage.getItem('studentSession') || 'null');
let pollTimer = null;

function show(id){
  document.querySelectorAll('main section').forEach(s=>s.classList.add('hidden'));
  $(id).classList.remove('hidden');
}
function goHome(){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer=null;
  show('home');
}
async function api(url, options={}){
  const res=await fetch(url,{headers:{'content-type':'application/json',...(options.headers||{})},...options});
  const data=await res.json().catch(()=>({error:'Некоректна відповідь сервера.'}));
  if(!res.ok) throw new Error(data.error||'Помилка запиту');
  return data;
}
function errorBox(id,error){$(id).textContent=error.message||String(error);$(id).classList.remove('hidden')}

async function createLesson(){
  $('teacherSetupResult').classList.add('hidden');
  try{
    const data=await api('/api/lessons',{method:'POST',body:JSON.stringify({name:$('lessonName').value,subject:$('subject').value,grade:$('grade').value})});
    teacher={...data.lesson,token:data.teacherToken};
    localStorage.setItem('teacherSession',JSON.stringify(teacher));
    await openTeacher();
  }catch(e){errorBox('teacherSetupResult',e)}
}
async function openTeacher(){
  if(!teacher?.code||!teacher?.token){show('teacherSetup');return}
  show('teacherRoom');
  $('teacherTitle').textContent=teacher.name;
  $('teacherSubject').textContent=teacher.subject;
  $('teacherCode').textContent=teacher.code;
  await refreshTeacher();
  if(pollTimer)clearInterval(pollTimer);
  pollTimer=setInterval(refreshTeacher,2000);
}
async function refreshTeacher(){
  try{
    const data=await api(`/api/teacher/lessons/${teacher.code}?token=${encodeURIComponent(teacher.token)}`);
    teacher={...teacher,...data.lesson};localStorage.setItem('teacherSession',JSON.stringify(teacher));
    renderTeacher(data);
  }catch(e){console.error(e)}
}
function renderTeacher(data){
  $('studentCount').textContent=data.students.length;
  $('students').innerHTML=data.students.length?data.students.map(s=>`<div class="student-item">👤 ${escapeHtml(s.name)}</div>`).join(''):'<div class="muted">Учні ще не приєдналися.</div>';
  $('questions').innerHTML=data.questions.length?data.questions.map((q,i)=>`<div class="question-item ${q.id===data.lesson.currentQuestionId?'active':''}"><b>${i+1}. ${escapeHtml(q.text)}</b><small>${q.options?.length?`Варіантів: ${q.options.length}`:'Відкрита відповідь'}</small></div>`).join(''):'<div class="muted">Додай перше питання або імпортуй урок з ChatGPT.</div>';
  $('teacherCurrent').textContent=data.currentQuestion?data.currentQuestion.text:'Питання ще не запущено.';
  $('answers').innerHTML=data.answers?.length?`<div class="section-head"><h3>Відповіді</h3></div>`+data.answers.map(a=>`<div class="answer-item"><b>${escapeHtml(a.name)}</b><br>${escapeHtml(a.answer_text)}</div>`).join(''):'';
  const startBtn=$('startLessonBtn');
  if(startBtn){
    startBtn.disabled=!data.questions.length || data.lesson.status==='finished';
    startBtn.textContent=data.lesson.status==='live'?'▶ Урок триває':'▶ Розпочати урок';
  }
}
function openQuestionForm(){$('questionForm').classList.toggle('hidden');$('questionText').focus()}
async function addQuestion(){
  try{
    const text=$('questionText').value.trim();
    const options=$('questionOptions').value.split('\n').map(x=>x.trim()).filter(Boolean);
    await api(`/api/teacher/lessons/${teacher.code}/questions`,{method:'POST',body:JSON.stringify({token:teacher.token,text,options})});
    $('questionText').value='';$('questionOptions').value='';$('questionForm').classList.add('hidden');await refreshTeacher();
  }catch(e){alert(e.message)}
}

function makeAiPrompt(){
  const prompt=`Ти — методист і вчитель-експерт. Створи повноцінний інтерактивний урок українською мовою для шкільної платформи.\n\nПараметри уроку:\n- Назва: ${teacher?.name||'вкажи назву'}\n- Предмет: ${teacher?.subject||'вкажи предмет'}\n- Клас: вкажи клас за контекстом або попроси мене уточнити\n\nЗавдання:\n1. Побудуй логічну послідовність від простого до складнішого.\n2. Створи 8–12 питань для учнів.\n3. Переважно використовуй тестові питання з 3–4 варіантами відповіді; частину зроби з відкритою відповіддю.\n4. Питання мають перевіряти розуміння, а не випадкове вгадування.\n5. Для тестових питань додай правильну відповідь у полі correct.\n6. Не вигадуй навчальні факти, якщо я дав джерело/текст — спирайся тільки на нього.\n\nПОВЕРНИ ЛИШЕ JSON без markdown і без пояснень у такому форматі:\n{\n  "lesson": {"name": "...", "subject": "...", "grade": "..."},\n  "questions": [\n    {"type":"choice","text":"...","options":["...","...","..."],"correct":"..."},\n    {"type":"text","text":"...","options":[],"correct":""}\n  ]\n}\n\nJSON має бути валідним. Не додавай жодного тексту до або після JSON.`;
  navigator.clipboard?.writeText(prompt).then(()=>alert('Промт скопійовано. Встав його в ChatGPT, отриманий JSON встав сюди.')).catch(()=>{
    $('aiImport').value=prompt;
    alert('Не вдалося скопіювати автоматично. Промт показано в полі нижче.');
  });
}
function parseAiJson(raw){
  let text=String(raw||'').trim();
  text=text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  const start=text.indexOf('{');
  const end=text.lastIndexOf('}');
  if(start>=0&&end>start) text=text.slice(start,end+1);
  return JSON.parse(text);
}
async function importAiLesson(){
  $('aiImportResult').classList.add('hidden');
  try{
    const data=parseAiJson($('aiImport').value);
    if(!data||!Array.isArray(data.questions)||!data.questions.length) throw new Error('У JSON немає масиву questions з питаннями.');
    const result=await api(`/api/teacher/lessons/${teacher.code}/questions/import`,{method:'POST',body:JSON.stringify({token:teacher.token,lesson:data.lesson||{},questions:data.questions})});
    if(result.lesson){teacher={...teacher,...result.lesson};localStorage.setItem('teacherSession',JSON.stringify(teacher));}
    $('aiImportResult').textContent=`Готово: імпортовано ${result.imported} питань.`;
    $('aiImportResult').classList.remove('hidden');
    $('aiImport').value='';
    await refreshTeacher();
  }catch(e){errorBox('aiImportResult',e)}
}
async function control(action){
  try{
    const data=await api(`/api/teacher/lessons/${teacher.code}/control`,{method:'POST',body:JSON.stringify({token:teacher.token,action})});
    renderTeacher(data);
  }catch(e){alert(e.message)}
}

async function joinLesson(){
  $('studentJoinResult').classList.add('hidden');
  try{
    const name=$('studentName').value.trim();
    const roomCode=$('roomCode').value.trim();
    const data=await api(`/api/lessons/${roomCode}/join`,{method:'POST',body:JSON.stringify({name})});
    student={studentId:data.studentId,code:roomCode,name,lesson:data.lesson};
    localStorage.setItem('studentSession',JSON.stringify(student));
    await openStudent();
  }catch(e){errorBox('studentJoinResult',e)}
}
async function openStudent(){
  if(!student?.code||!student?.studentId){show('studentJoin');return}
  show('studentRoom');
  $('studentTitle').textContent=student.lesson?.name||'Урок';
  $('studentSubject').textContent=student.lesson?.subject||'';
  $('studentCode').textContent=student.code;
  await refreshStudent();
  if(pollTimer)clearInterval(pollTimer);
  pollTimer=setInterval(refreshStudent,2000);
}
async function refreshStudent(){
  try{
    const data=await api(`/api/lessons/${student.code}/student/${encodeURIComponent(student.studentId)}`);
    renderStudent(data);
  }catch(e){console.error(e)}
}
function renderStudent(data){
  $('studentStatus').textContent=data.lesson.status==='live'?'Урок триває':data.lesson.status==='finished'?'Урок завершено':'Очікування вчителя';
  $('studentTitle').textContent=data.lesson.name;
  $('studentSubject').textContent=data.lesson.subject;
  $('studentCode').textContent=data.lesson.code;
  const q=data.currentQuestion;
  if(!q){$('studentQuestion').innerHTML='<div class="eyebrow">ЗАРАЗ</div><h3>Очікуємо питання…</h3><p class="muted">Коли вчитель розпочне урок, тут з\'явиться завдання.</p>'; $('answerArea').innerHTML='';return}
  $('studentQuestion').innerHTML=`<div class="eyebrow">ПИТАННЯ</div><h3>${escapeHtml(q.text)}</h3>`;
  const options=q.options||[];
  if(options.length){$('answerArea').innerHTML=`<div class="choice-grid">${options.map((o,i)=>`<button class="choice" onclick="sendAnswer(${JSON.stringify(o)})">${i+1}. ${escapeHtml(o)}</button>`).join('')}</div>`}
  else $('answerArea').innerHTML='<textarea id="freeAnswer" rows="3" placeholder="Напиши відповідь..."></textarea><button class="primary" onclick="sendAnswer(document.getElementById(\'freeAnswer\').value)">Надіслати відповідь</button>';
}
async function sendAnswer(answer){
  try{await api(`/api/lessons/${student.code}/answer`,{method:'POST',body:JSON.stringify({studentId:student.studentId,answer})});$('studentAnswerResult').classList.remove('hidden');setTimeout(()=>$('studentAnswerResult').classList.add('hidden'),2500)}catch(e){alert(e.message)}
}
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}

window.addEventListener('load',()=>{
  if(location.hash==='#teacher'&&teacher)openTeacher();
  else if(location.hash==='#student'&&student)openStudent();
});
window.addEventListener('beforeunload',()=>{if(pollTimer)clearInterval(pollTimer)});
