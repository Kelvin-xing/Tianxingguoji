import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDirectoryCommand, directoryValuesEqual } from '../../../modules/schools/public.ts';
import { trialWorkspaceCapabilities, workspaceCapabilitiesForRole, type TrialPrincipal } from '../../../modules/access/public.ts';
import { capabilityForPath, visibleWorkspaceNavigation, WORKSPACE_NAVIGATION } from '../../../components/layout/workspace-navigation.ts';
const id='51000000-0000-4000-8000-000000000101';
test('directory accepts one name but rejects empty, invalid field/value, identity edits and malformed versions',()=>{
  assert.equal(parseDirectoryCommand({action:'create',nameZh:'合成',nameEn:''}).action,'create');
  for(const value of [null,{}, {action:'create',nameZh:' ',nameEn:'\t'},
    {action:'field',schoolId:id,version:0,field:'phone',value:'1'},
    {action:'field',schoolId:id,version:1,field:'edb_number',value:'123456'},
    {action:'field',schoolId:id,version:1,field:'phone',value:true},
    {action:'field',schoolId:id,version:1,field:'has_boarding',value:'false'}]) assert.throws(()=>parseDirectoryCommand(value));
});
test('website comparison ignores only the three approved differences',()=>{
  assert.equal(directoryValuesEqual('official_website','http://www.synthetic.invalid/','https://synthetic.invalid'),true);
  assert.equal(directoryValuesEqual('official_website','https://synthetic.invalid/a','https://synthetic.invalid/b'),false);
  assert.equal(directoryValuesEqual('profile_url','http://synthetic.invalid','https://synthetic.invalid'),false);
  assert.equal(directoryValuesEqual('phone','555 1','5551'),false);
});
test('new directory capability is additive for active trial levels; old capabilities and navigation stay unchanged',()=>{
  for(const level of ['founder','l1','l2','l3'] as const){
    const principal={level,active:true} as TrialPrincipal;
    const caps=trialWorkspaceCapabilities(principal);
    assert.ok(caps.includes('school_directory.manage'));
    if(level!=='founder') assert.deepEqual(caps.filter(c=>c!=='school_directory.manage'),workspaceCapabilitiesForRole(level));
    assert.deepEqual(trialWorkspaceCapabilities({...principal,active:false}),[]);
    assert.ok(!visibleWorkspaceNavigation(caps).some(n=>n.href==='/school-directory'));
  }
  for(const n of WORKSPACE_NAVIGATION) assert.equal(capabilityForPath(n.href),n.capability);
  assert.equal(capabilityForPath('/schools/example'),'schools.read');
  assert.equal(capabilityForPath('/selector'),null);
  assert.equal(capabilityForPath('/school-directory'),'school_directory.manage');
  assert.equal(capabilityForPath('/school-directory-other'),null);
  for(const role of ['advisor','admin','contractor','data_reviewer'] as const) assert.ok(!workspaceCapabilitiesForRole(role).includes('school_directory.manage'));
});
