import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import * as XLSX from 'xlsx';
import {openDatabase,batchDetail} from '../lib/database.mjs';
import {importFiles,exportDownload} from '../lib/excel.mjs';
import {normalizeBatch,normalizePreviewNames,reviseRows} from '../lib/naming.mjs';
const name='완전밀착 새싹(면100수) D타입 High(13cm)', barcode='8809538930160';
function imported(db) {
 const b=XLSX.utils.book_new();XLSX.utils.book_append_sheet(b,XLSX.utils.aoa_to_sheet([
  ['상품명','옵션명','수량'],['가상 원본 쿠션','면100수 새싹 13cm',2],['가상 원본 쿠션','면100수 새싹 13cm',1],
 ]),'주문');return importFiles(db,[{originalname:'가상 SKU 주문.xlsx',buffer:XLSX.write(b,{type:'buffer',bookType:'xlsx'})}]);
}
const change=(row,cleanedName)=>({id:row.id,cleanedName,reviewNote:'',status:'confirmed'});
function memory(t){const db=openDatabase(':memory:');t.after(()=>db.close());return db;}

test('정리된 제품명이 포함된 주문·제품명 연결 파일은 업로드 직후 같은 바코드를 표시한다',async t=>{
 const db=memory(t);
 for(const [filename,rows] of [
  ['정리된 주문.xlsx',[['상품명','정리된 제품명'],['가상 원본 쿠션',name],['미등록 원본','바코드표에 없는 방수커버']]],
  ['제품명_옵션명_연결.xlsx',[['가상 원본 쿠션',name],['미등록 원본','바코드표에 없는 방수커버']]],
 ]){
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'주문');
  const result=importFiles(db,[{originalname:filename,buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx'})}]);
  assert.deepEqual(result.rows.map(row=>row.skuBarcode),[barcode,null]);
  const unchanged=await normalizeBatch(db,result.batch.id,null,'mock');
  assert.deepEqual(unchanged.rows.map(row=>row.skuBarcode),[barcode,null]);
 }
});

test('직원이 확정한 제품명에 바코드를 연결하고 미등록 제품으로 수정하면 기존 연결을 비운다',async t=>{
 const db=memory(t),source=imported(db);
 let result=reviseRows(db,source.batch.id,source.rows.map(row=>change(row,name)));
 assert.ok(result.rows.every(row=>row.skuBarcode===barcode));
 assert.ok(db.prepare('SELECT sku_barcode FROM rows').all().every(row=>row.sku_barcode===barcode));
 result=reviseRows(db,source.batch.id,[change(result.rows[0],'바코드표에 없는 방수커버')]);
 assert.equal(result.rows[0].skuBarcode,null); assert.equal(result.rows[1].skuBarcode,barcode);
 assert.deepEqual(result.rows.map(row=>row.originalName),source.rows.map(row=>row.originalName));
 const exported=XLSX.read((await exportDownload(db,source.batch.id)).buffer,{type:'buffer'});
 assert.deepEqual(XLSX.utils.sheet_to_json(exported.Sheets['주문'],{header:1}).map(row=>row.length),[3,3,3]);
});

test('LLM 정리와 기존 이름 재사용 및 신규 주문 미리보기는 같은 SKU를 연결하고 추가 LLM 호출을 하지 않는다',async t=>{
 const db=memory(t),source=imported(db);let calls=0;
 const client={responses:{create:async request=>{calls++;return {output_text:JSON.stringify({items:JSON.parse(request.input).map(row=>({id:row.id,cleanedName:name,needsAttention:false,note:''}))})};}}};
 let result=await normalizeBatch(db,source.batch.id,client,'mock');
 assert.ok(result.rows.every(row=>row.skuBarcode===barcode));assert.equal(calls,1);
 result=reviseRows(db,source.batch.id,result.rows.map(row=>change(row,name)));
 const next=imported(db),reused=await normalizeBatch(db,next.batch.id,null,'mock');
 assert.ok(reused.rows.every(row=>row.skuBarcode===barcode&&row.nameSource==='reused'));assert.equal(calls,1);
 const before=db.prepare('SELECT count(*) n FROM rows').get().n;
 const preview=await normalizePreviewNames(db,[{id:1,originalName:result.rows[0].originalName,productName:'가상 원본 쿠션',optionName:result.rows[0].optionName}],null,'mock');
 assert.equal(preview[0].skuBarcode,barcode);assert.equal(db.prepare('SELECT count(*) n FROM rows').get().n,before);
});

test('기존 DB 재시작은 제품명과 원본을 바꾸지 않고 바코드만 채우며 반복해도 동일하다',t=>{
 const directory=mkdtempSync(path.join(os.tmpdir(),'system0-sku-')),file=path.join(directory,'old.sqlite');
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let db=openDatabase(file),source=imported(db);
 db.prepare('UPDATE rows SET cleaned_name=?,status=?').run(name,'confirmed');
 const originals=db.prepare('SELECT original_name,cleaned_name,status FROM rows ORDER BY id').all();db.close();
 db=openDatabase(file);
 assert.ok(batchDetail(db,source.batch.id).rows.every(row=>row.skuBarcode===barcode));
 assert.deepEqual(db.prepare('SELECT original_name,cleaned_name,status FROM rows ORDER BY id').all(),originals);
 const once=db.prepare('SELECT * FROM rows ORDER BY id').all();db.close();
 db=openDatabase(file);assert.deepEqual(db.prepare('SELECT * FROM rows ORDER BY id').all(),once);db.close();
});
