import assert from 'node:assert/strict';
import type {Page} from 'playwright-core';
import type {Client} from 'pg';

export async function assertTrialCrmProfileBrowser(input:{page:Page;baseUrl:string;client:Client;studentId:string;guardianId:string}){
  const {page,baseUrl,client,studentId,guardianId}=input;
  await page.goto(`${baseUrl}/students/${studentId}`);
  await page.getByRole('button',{name:'編輯學生資料',exact:true}).click();
  await page.getByRole('textbox',{name:'學生姓名',exact:true}).fill('Synthetic profile browser student');
  const studentResponse=page.waitForResponse(response=>response.url().endsWith(`/api/v1/students/${studentId}`)&&response.request().method()==='PATCH');
  await page.getByRole('button',{name:'儲存學生資料',exact:true}).click();
  assert.equal((await studentResponse).status(),200);
  await page.getByText('學生資料已儲存。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'編輯監護人資料',exact:true}).click();
  await page.getByRole('textbox',{name:'監護人姓名',exact:true}).fill('Synthetic profile browser guardian');
  const guardianResponse=page.waitForResponse(response=>response.url().endsWith(`/api/v1/guardians/${guardianId}`)&&response.request().method()==='PATCH');
  await page.getByRole('button',{name:'儲存監護人資料',exact:true}).click();
  assert.equal((await guardianResponse).status(),200);
  await page.getByText('監護人資料已儲存。',{exact:true}).waitFor();
  await page.reload();
  await page.getByRole('button',{name:'編輯學生資料',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'學生姓名',exact:true}).inputValue(),'Synthetic profile browser student');
  assert.equal((await client.query('SELECT display_name FROM crm_guardians WHERE id=$1',[guardianId])).rows[0].display_name,'Synthetic profile browser guardian');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.screenshot({path:'/tmp/access-trial-crm-profile-mobile.png',fullPage:true});
  process.stdout.write(JSON.stringify({trial_crm_profile_browser:'pass',l1:'student_and_guardian_edit_reload',viewport:390})+'\n');
}
