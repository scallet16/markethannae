import { firebaseConfig, defaultClassId } from './firebase-config.js';
import { getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { get, getDatabase, onValue, ref, runTransaction } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';

const app=getApps()[0]||initializeApp(firebaseConfig);
const database=getDatabase(app);
const requestedClassId=new URLSearchParams(location.search).get('classId');
export const classId=(requestedClassId||defaultClassId||'default').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40)||'default';
const classRef=ref(database,`classes/${classId}`);
const studentsRef=ref(database,`classes/${classId}/students`);

const historyArray=history=>(Array.isArray(history)?history:Object.entries(history||{}).map(([purchaseId,item])=>({purchaseId,...item}))).sort((a,b)=>(a.purchasedAt||0)-(b.purchasedAt||0));
const historyObject=history=>Object.fromEntries(historyArray(history).map((item,index)=>[item.purchaseId||`legacy_${index}`,{item:item.item,amount:Number(item.amount)||0,time:item.time||'',purchasedAt:item.purchasedAt||0}]));
const spentFromHistory=history=>historyArray(history).reduce((sum,item)=>sum+(item.amount>0?item.amount:0),0);
const normalizeStudent=student=>({id:String(student.id),name:student.name,balance:Number(student.balance)||0,totalSpent:Number.isFinite(Number(student.totalSpent))?Number(student.totalSpent):spentFromHistory(student.history),history:historyArray(student.history)});
const firebaseStudent=student=>{const normalized=normalizeStudent(student);return {...normalized,history:historyObject(normalized.history)}};
export const normalizeStudents=value=>Object.values(value||{}).map(normalizeStudent).sort((a,b)=>a.id-b.id);
export const normalizeBoothId=value=>String(value||'').toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,40);
export function createPurchaseId(boothId,studentId){
  const booth=normalizeBoothId(boothId);
  if(!booth)throw Error('boothId is required');
  return `${booth}_${studentId}_${Date.now()}_${Math.random().toString(36).slice(2,10)}`;
}

export async function initializeStudentSource(cachedStudents,defaultStudents){
  const remote=await get(studentsRef);
  if(remote.exists())return normalizeStudents(remote.val());
  return normalizeStudents(cachedStudents?.length?cachedStudents:defaultStudents);
}

export function subscribeStudents(callback,onError=console.error){
  return onValue(studentsRef,snapshot=>callback(normalizeStudents(snapshot.val())),onError);
}

export async function purchaseFromStudent({classId:paymentClassId=classId,studentId,studentName,itemName,menuName,category='',quantity=1,amount,totalAmount,booth,purchaseId,purchasedAt,paidAt}){
  const boothId=normalizeBoothId(booth);
  const studentKey=String(studentId);
  const finalItemName=itemName||menuName;
  const finalAmount=Number(amount??totalAmount);
  const finalPurchasedAt=purchasedAt||paidAt||Date.now();
  const context={stage:'validate',classId:paymentClassId,studentId:studentKey,studentPath:`classes/${paymentClassId}/students/${studentKey}`,purchasePath:`classes/${paymentClassId}/purchases/${purchaseId}`,snackPath:boothId==='snack'?`classes/${paymentClassId}/snack/purchases/${purchaseId}`:null,itemName:finalItemName,amount:finalAmount};
  if(paymentClassId!==classId)throw Object.assign(Error('classId does not match the current page'),{code:'payment/class-id-mismatch',paymentContext:context});
  if(!boothId)throw Error('boothId is required');
  if(!purchaseId)throw Error('purchaseId is required');
  if(!finalItemName||!Number.isFinite(finalAmount)||finalAmount<1)throw Error('valid itemName and amount are required');
  try{
    context.stage='read-student';
    const classSnapshot=await get(classRef);
    const baseline=classSnapshot.val()||{};
    if(!baseline.students?.[studentKey])return {committed:false,reason:'missing',context,students:normalizeStudents(baseline.students)};
    let reason='missing';
    context.stage='transaction';
    const result=await runTransaction(classRef,current=>{
      const next=current||baseline, students={...(next.students||{})}, student=students[studentKey];
      if(!student){reason='missing';return}
      const currentBalance=Number(student.balance);
      if(!Number.isFinite(currentBalance)){reason='invalid-balance';return}
      if(finalAmount>currentBalance){reason='insufficient';return}
      if(next.purchases?.[purchaseId]){reason='duplicate';return}
      reason='purchased';
      const history={...historyObject(student.history),[purchaseId]:{item:finalItemName,amount:finalAmount,time:new Date(finalPurchasedAt).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}),purchasedAt:finalPurchasedAt}};
      const normalized=normalizeStudent(student);
      students[studentKey]={id:studentKey,name:normalized.name,balance:currentBalance-finalAmount,totalSpent:(normalized.totalSpent||0)+finalAmount,history};
      const purchase={purchaseId,studentId:studentKey,studentName:student.name||studentName,booth:boothId,category,itemName:finalItemName,amount:finalAmount,quantity:Number(quantity)||1,purchasedAt:finalPurchasedAt,status:'paid'};
      const updated={...next,students,purchases:{...(next.purchases||{}),[purchaseId]:purchase}};
      if(boothId==='snack')updated.snack={...(next.snack||{}),purchases:{...(next.snack?.purchases||{}),[purchaseId]:purchase}};
      return updated;
    },{applyLocally:false});
    context.stage=result.committed?'complete':'aborted';
    return {committed:result.committed,reason,context,students:normalizeStudents(result.snapshot.val()?.students)};
  }catch(error){
    error.paymentContext={...context,stage:context.stage||'unknown'};
    console.error('[Firebase payment transaction failed]',{code:error?.code,message:error?.message,context:error.paymentContext,error});
    throw error;
  }
}

export async function addStudentBonus(studentId,amount){
  const result=await runTransaction(studentsRef,current=>{
    const students={...(current||{})},student=students[studentId];
    if(!student)return;
    const timestamp=Date.now(),history={...historyObject(student.history),[`bonus_${timestamp}`]:{item:'🎁 보너스 용돈',amount:-amount,time:new Date(timestamp).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}),purchasedAt:timestamp}};
    students[studentId]={...firebaseStudent(student),balance:(Number(student.balance)||0)+amount,history};
    return students;
  },{applyLocally:false});
  return {committed:result.committed,students:normalizeStudents(result.snapshot.val())};
}

export async function saveStudentSettings(settings){
  const result=await runTransaction(studentsRef,current=>{
    if(!current)return;
    const students={...current};
    settings.forEach(setting=>{const student=students[setting.id];if(student)students[setting.id]={...firebaseStudent(student),name:setting.name,balance:Number(setting.balance)||0}});
    return students;
  },{applyLocally:false});
  return {committed:result.committed,students:normalizeStudents(result.snapshot.val())};
}

export async function resetStudentData(startBalance){
  const result=await runTransaction(studentsRef,current=>{
    if(!current)return;
    const students={...current};
    Object.keys(students).forEach(id=>{students[id]={...firebaseStudent(students[id]),balance:startBalance,totalSpent:0,history:{}}});
    return students;
  },{applyLocally:false});
  return {committed:result.committed,students:normalizeStudents(result.snapshot.val())};
}
