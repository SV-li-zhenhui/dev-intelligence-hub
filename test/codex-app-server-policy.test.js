import assert from 'node:assert/strict';
import test from 'node:test';
import { appServerArguments, threadConfiguration, assertEffectiveAppServerPolicy } from '../src/lib/codex-app-server-policy.js';

test('app-server policy uses supported overrides without moving native home',()=>{
  const args=appServerArguments({model:'gpt-6.1-sol',reasoningEffort:'high'},'D:/private/instructions.txt',true);
  assert.equal(args[0],'app-server');assert.ok(args.includes('--stdio'));assert.equal(args.includes('--strict-config'),false);
  assert.equal(args.includes('--ignore-user-config'),false);assert.equal(args.includes('--ignore-rules'),false);
  assert.ok(args.includes('features.shell_tool=false'));assert.ok(args.includes('notify=[]'));
  assert.ok(args.includes('features.code_mode_host=true'));
  assert.ok(args.includes('features.multi_agent_v2=false'));
  assert.ok(args.includes('agents.max_concurrent_threads_per_session=3'));
});

test('thread policy disables each inherited MCP without copying private configuration',()=>{
  const configured={mcp_servers:{'old.server':{command:'secret',env:{TOKEN:'private'}},'odd"name':{url:'private'}},
    agents:{default:{config_file:'D:/unsafe.toml'},custom:{config_file:'D:/other.toml'},enabled:true,max_depth:8}};
  const result=threadConfiguration(configured,{reader:{url:'http://127.0.0.1:1234/review/token'},agentConfigPath:'D:/private/reviewer.toml',namespace:'dih_pr_review_0123456789abcdef'});
  assert.equal(result.mcp_servers['old.server'].enabled,false);
  assert.equal(result.mcp_servers['odd"name'].enabled,false);
  assert.equal(result.mcp_servers.dih_pr_review_0123456789abcdef.url,'http://127.0.0.1:1234/review/token');
  assert.equal(result.agents.custom.config_file,'D:/private/reviewer.toml');
  assert.equal(JSON.stringify(result).includes('private"'),false);
  assert.equal(JSON.stringify(result).includes('unsafe.toml'),false);
});

test('thread policy refuses alias collisions and malformed inventories',()=>{
  const options={namespace:'dih_pr_review_0123456789abcdef',reader:{url:'http://127.0.0.1:1234/review/token'},agentConfigPath:'D:/private/role.toml'};
  assert.throws(()=>threadConfiguration({mcp_servers:{[options.namespace]:{}}},options),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
  assert.throws(()=>threadConfiguration({mcp_servers:[]},options),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
});

test('code-job policy exposes only host execution tools in a separate namespace',()=>{
  const options={channel:'code-job',namespace:'dih_code_job_0123456789abcdef',
    execution:{url:'http://127.0.0.1:1234/code-execution/token'},agentConfigPath:'D:/private/role.toml'};
  const result=threadConfiguration({mcp_servers:{pr_review:{url:'private'}},agents:{enabled:true,default:{config_file:'unsafe'}}},options);
  assert.equal(result.mcp_servers.pr_review.enabled,false);
  assert.deepEqual(result.mcp_servers[options.namespace].enabled_tools,['perform_action','read_source','get_state']);
  assert.equal(result.agents.enabled,false);
  assert.throws(()=>threadConfiguration({}, {...options,reader:{url:'private'}}),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
  assert.throws(()=>threadConfiguration({}, {...options,namespace:'dih_pr_review_0123456789abcdef'}),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
  assert.throws(()=>threadConfiguration({mcp_servers:{[options.namespace]:{}}},options),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
  assert.throws(()=>assertEffectiveAppServerPolicy({}, {channel:'unexpected'}),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
});
