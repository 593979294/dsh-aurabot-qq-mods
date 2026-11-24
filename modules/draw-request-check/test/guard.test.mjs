import test from 'node:test'
import assert from 'node:assert/strict'
import guard, {requestOf} from '../index.mjs'
const user = (id, text) => ({role:'user',id,source:{kind:'aurabot'},content:[{type:'text',text}]})
const group = user('a','【群聊 测试】之前在聊：\n甲：画一张\n\n【群聊 测试】刚才新说的（1 条）\n[1] 乙(12345)@了你：查人物\n\n每行开头是说话人。')
const privateMsg = user('b','【私聊】甲：换成蓝色')
const runtime = {role:'user',source:{kind:'runtime-context'},content:[{type:'text',text:'绘图规则'}]}
test('only current chat input and adjacent exchange can support a draw',()=>{
 const messages=[group,{role:'assistant',content:[{type:'text',text:'有这些人物。'}]},privateMsg,runtime,{role:'user',source:{kind:'repeat-tool-reminder',form:'notice'},content:[]},{role:'tool',content:[]},{role:'assistant',content:[{type:'text',text:'我还可以画图。'}]}];
 assert.deepEqual(requestOf(messages),{id:'b',current:'【私聊】甲：换成蓝色',previous:'[1] 乙(12345)@了你：查人物',reply:'有这些人物。'});
 assert.equal(requestOf([...messages,user('scheduled','系统任务')]),null)
})
async function harness(response){
 let hook,calls=0,passed=0;const session={id:'s',deriveMessages:()=>[group]};let dispose;
 const api={dsh:{on:(event,h)=>{assert.equal(event,'tools/pre-execute');hook=h;return ()=>{}},llm:{async *stream(req){calls++;assert.equal(req.tools.length,0);yield {type:'text-delta',text:response};yield {type:'finish',reason:{kind:'stop'}}}}},core:{hub:{modelFor:()=>({provider:'test',model:'test'}),chatOfSession:()=> 'group:123'}},onDispose:f=>dispose=f};guard.setup(api);
 const run=(name='qq_draw_image')=>hook({name,agent:{session},signal:new AbortController().signal},()=>{passed++;return {kind:'allow'}});return {run,get calls(){return calls},get passed(){return passed},dispose,session}
}
test('lookup and uncertain/invalid decisions cannot start generation or its slow notice',async()=>{for(const v of ['OTHER','UNCLEAR','maybe']){const h=await harness(v);assert.equal((await h.run()).kind,'deny');assert.equal(h.passed,0);await h.run();assert.equal(h.calls,1);h.dispose()}})
test('explicit draw still runs downstream permissions; other tools bypass review',async()=>{const h=await harness('DRAW 换成蓝色');h.session.deriveMessages=()=>[privateMsg];assert.equal((await h.run('qq_web_search')).kind,'allow');assert.equal(h.calls,0);assert.equal((await h.run()).kind,'allow');assert.equal(h.calls,1);h.dispose()})

test('quoted bot offer and punctuation alone do not authorize another picture',async()=>{const h=await harness('DRAW 画好了发你');h.session.deriveMessages=()=>[user('z','【私聊】甲：？？？ （引用 你 的消息：「画好了发你」）')];assert.equal((await h.run()).kind,'deny');assert.equal(h.calls,0);h.dispose()})
