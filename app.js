function hideAll(){document.querySelector('.hero').classList.add('hidden');document.querySelectorAll('.panel').forEach(x=>x.classList.add('hidden'))}
function showTeacher(){hideAll();document.getElementById('teacherPanel').classList.remove('hidden')}
function showStudent(){hideAll();document.getElementById('studentPanel').classList.remove('hidden')}
function goHome(){document.querySelector('.hero').classList.remove('hidden');document.querySelectorAll('.panel').forEach(x=>x.classList.add('hidden'))}
function randomCode(){return String(Math.floor(100000+Math.random()*900000))}
function createDemoLesson(){
 const name=document.getElementById('lessonName').value.trim()||'Інтерактивний урок';
 const subject=document.getElementById('subject').value.trim()||'Шкільний урок';
 const code=randomCode();
 localStorage.setItem('demoLesson',JSON.stringify({name,subject,code}));
 const r=document.getElementById('teacherResult');
 r.innerHTML=`<div>Урок створено у демонстраційному режимі.<br><strong>${code}</strong><small>Передайте цей код учням.</small></div>`;
 r.classList.remove('hidden');
}
function joinDemoLesson(){
 const name=document.getElementById('studentName').value.trim()||'Учень';
 const code=document.getElementById('roomCode').value.trim();
 const lesson=JSON.parse(localStorage.getItem('demoLesson')||'null');
 const r=document.getElementById('studentResult');
 if(!lesson||code!==lesson.code){r.textContent='У демонстрації такого активного уроку немає. Спочатку створіть урок на цьому пристрої.';r.classList.remove('hidden');return}
 hideAll();document.getElementById('lessonPanel').classList.remove('hidden');
 document.getElementById('lessonTitle').textContent=`${lesson.name} — ${name}`;
 document.getElementById('shownCode').textContent=lesson.code;
}
function answer(){document.getElementById('answerResult').classList.remove('hidden')}
