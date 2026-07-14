import { firebaseConfig, defaultClassId } from './firebase-config.js';
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { getDatabase, onValue, ref, runTransaction } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';

const app=getApps()[0]||initializeApp(firebaseConfig);
const database=getDatabase(app);
const requestedClassId=new URLSearchParams(location.search).get('classId');
export const classId=(requestedClassId||defaultClassId||'default').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40)||'default';
const snackRef=ref(database,`classes/${classId}/snack`);

const values=value=>Object.values(value||{});
const byTime=(field)=>(a,b)=>(a[field]||0)-(b[field]||0);

export function normalizeSnack(value){
  return {
    purchases:values(value?.purchases).sort(byTime('paidAt')),
    waiting:values(value?.waiting).sort(byTime('registeredAt')),
    completed:values(value?.completed).sort(byTime('completedAt'))
  };
}

export function subscribeSnack(callback,onError=console.error){
  return onValue(snackRef,snapshot=>callback(normalizeSnack(snapshot.val())),onError);
}

export async function recordSnackPurchase(purchase){
  const purchaseRef=ref(database,`classes/${classId}/snack/purchases/${purchase.purchaseId}`);
  const result=await runTransaction(purchaseRef,current=>current||{
    purchaseId:purchase.purchaseId,
    studentId:purchase.studentId,
    studentName:purchase.studentName,
    menuName:purchase.menuName,
    quantity:purchase.quantity,
    totalAmount:purchase.totalAmount,
    paidAt:purchase.paidAt,
    status:'paid'
  },{applyLocally:false});
  return result.committed;
}

export async function registerWaiting(purchaseId){
  let reason='invalid';
  const result=await runTransaction(snackRef,snack=>{
    const next=snack||{}, purchase=next.purchases?.[purchaseId];
    if(!purchase){reason='missing';return}
    if(next.waiting?.[purchaseId]){reason='duplicate';return}
    if(purchase.status!=='paid'){reason='not-paid';return}
    reason='registered';
    return {
      ...next,
      purchases:{...(next.purchases||{}),[purchaseId]:{...purchase,status:'waiting'}},
      waiting:{...(next.waiting||{}),[purchaseId]:{...purchase,status:'waiting',registeredAt:Date.now()}}
    };
  },{applyLocally:false});
  return {committed:result.committed,reason};
}

export async function completeWaiting(purchaseId){
  let reason='missing';
  const result=await runTransaction(snackRef,snack=>{
    const next=snack||{}, waiting=next.waiting?.[purchaseId], purchase=next.purchases?.[purchaseId];
    if(!waiting||!purchase)return;
    reason='completed';
    const waitingList={...(next.waiting||{})};
    delete waitingList[purchaseId];
    return {
      ...next,
      purchases:{...(next.purchases||{}),[purchaseId]:{...purchase,status:'completed'}},
      waiting:waitingList,
      completed:{...(next.completed||{}),[purchaseId]:{...waiting,status:'completed',completedAt:Date.now()}}
    };
  },{applyLocally:false});
  return {committed:result.committed,reason};
}

export async function undoLatestCompleted(){
  let restored=null;
  const result=await runTransaction(snackRef,snack=>{
    const next=snack||{};
    const latest=values(next.completed).sort((a,b)=>(b.completedAt||0)-(a.completedAt||0))[0];
    if(!latest||next.waiting?.[latest.purchaseId])return;
    const purchase=next.purchases?.[latest.purchaseId];
    if(!purchase||purchase.status!=='completed')return;
    restored=latest;
    const completed={...(next.completed||{})};
    delete completed[latest.purchaseId];
    const {completedAt,...waiting}=latest;
    return {
      ...next,
      purchases:{...(next.purchases||{}),[latest.purchaseId]:{...purchase,status:'waiting'}},
      waiting:{...(next.waiting||{}),[latest.purchaseId]:{...waiting,status:'waiting'}},
      completed
    };
  },{applyLocally:false});
  return {committed:result.committed,restored};
}
