import { firebaseConfig, defaultClassId } from './firebase-config.js';
import { getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { get, getDatabase, onValue, ref, runTransaction } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';

const app=getApps()[0]||initializeApp(firebaseConfig);
const database=getDatabase(app);
const requestedClassId=new URLSearchParams(location.search).get('classId');
export const classId=(requestedClassId||defaultClassId||'default').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40)||'default';
const classRef=ref(database,`classes/${classId}`);
const studentsRef=ref(database,`classes/${classId}/students`);

const historyArray=history=>Array.isArray(history)?history:Object.values(history||{});
const normalizeStudent=student=>({id:student.id,name:student.name,balance:student.balance,history:historyArray(student.history)});
export const normalizeStudents=value=>Object.values(value||{}).map(normalizeStudent).sort((a,b)=>a.id-b.id);

export async function initializeStudentSource(cachedStudents,defaultStudents){
  const remote=await get(studentsRef);
  if(remote.exists())return normalizeStudents(remote.val());
  const seed=(cachedStudents?.length?cachedStudents:defaultStudents).map(student=>({...student,history:historyArray(student.history)}));
  const result=await runTransaction(studentsRef,current=>current||seed,{applyLocally:false});
  return normalizeStudents(result.snapshot.val());
}

export function subscribeStudents(callback,onError=console.error){
  return onValue(studentsRef,snapshot=>callback(normalizeStudents(snapshot.val())),onError);
}

export async function purchaseFromStudent({studentId,studentName,menuName,quantity=1,totalAmount,booth,purchaseId,paidAt=Date.now()}){
  let reason='missing';
  const result=await runTransaction(classRef,current=>{
    const next=current||{}, students={...(next.students||{})}, student=students[studentId];
    if(!student)return;
    if(totalAmount>student.balance){reason='insufficient';return}
    if(next.purchases?.[purchaseId]){reason='duplicate';return}
    reason='purchased';
    const history=[...historyArray(student.history),{item:menuName,amount:totalAmount,time:new Date(paidAt).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}];
    students[studentId]={...normalizeStudent(student),balance:student.balance-totalAmount,history};
    const purchase={purchaseId,studentId,studentName:student.name||studentName,menuName,quantity,totalAmount,paidAt,booth,status:'paid'};
    const updated={...next,students,purchases:{...(next.purchases||{}),[purchaseId]:purchase}};
    if(booth==='snack')updated.snack={...(next.snack||{}),purchases:{...(next.snack?.purchases||{}),[purchaseId]:purchase}};
    return updated;
  },{applyLocally:false});
  return {committed:result.committed,reason,students:normalizeStudents(result.snapshot.val()?.students)};
}

export async function addStudentBonus(studentId,amount){
  const result=await runTransaction(studentsRef,current=>{
    const students={...(current||{})},student=students[studentId];
    if(!student)return;
    students[studentId]={...normalizeStudent(student),balance:(student.balance||0)+amount,history:[...historyArray(student.history),{item:'🎁 보너스 용돈',amount:-amount,time:new Date().toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}]};
    return students;
  },{applyLocally:false});
  return {committed:result.committed,students:normalizeStudents(result.snapshot.val())};
}

export async function saveStudentSettings(settings){
  const result=await runTransaction(studentsRef,current=>{
    if(!current)return;
    const students={...current};
    settings.forEach(setting=>{const student=students[setting.id];if(student)students[setting.id]={...normalizeStudent(student),name:setting.name,balance:setting.balance}});
    return students;
  },{applyLocally:false});
  return {committed:result.committed,students:normalizeStudents(result.snapshot.val())};
}

export async function resetStudentData(startBalance){
  const result=await runTransaction(studentsRef,current=>{
    if(!current)return;
    const students={...current};
    Object.keys(students).forEach(id=>{students[id]={...normalizeStudent(students[id]),balance:startBalance,history:[]}});
    return students;
  },{applyLocally:false});
  return {committed:result.committed,students:normalizeStudents(result.snapshot.val())};
}
