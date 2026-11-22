"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { grantTesterAccount } = require("./scripts/grant-tester-images");
const env = { JWT_SECRET: "local-only-cli-test-secret-value-long", BOT_ADMIN_WHATSAPP: "local-admin", PORT: "10000" };
const bonus = { granted: true, limit: 5, remaining: 5, grantId: "local-grant" };
function mock(responses) {
 const calls = []; return { calls, fetchImpl: async (url, options) => {
  calls.push({ url, options });
  const data = responses.shift(); if (!data) throw new Error("Unexpected request");
  return { ok: data.status ? data.status < 400 : true, json: async () => data.body || data };
 }};
}
test("new account uses loopback admin route then verifies the new access and allowance", async () => {
 const m=mock([{ok:true,account:{created:true},credentials:{password:"Time-12345678"},bonus},{ok:true,token:"local-user-session"},{ok:true,tester_image_bonus:bonus}]);
 const r=await grantTesterAccount({email:"TIME@example.com",env,fetchImpl:m.fetchImpl});
 assert.equal(r.verified,true);assert.equal(r.email,"time@example.com");assert.equal(r.credentials.password,"Time-12345678");assert.equal(m.calls.length,3);
 assert.ok(m.calls.every(c=>c.url.startsWith("http://127.0.0.1:10000/")));
 assert.ok(m.calls.every(c=>c.options.redirect === "error"));
 assert.deepEqual(JSON.parse(m.calls[0].options.body),{login:"time@example.com",create_account:true});
 assert.match(m.calls[2].options.headers.Authorization,/local-user-session$/);
});
test("existing account preserves credentials and verifies current remaining quota without resetting",async()=>{
 const partial={...bonus,remaining:3};const m=mock([{ok:true,account:{created:false,login_type:"google"},bonus:partial},{ok:true,bonus:partial}]);
 const r=await grantTesterAccount({email:"time@example.com",env,fetchImpl:m.fetchImpl});assert.equal(r.verified,true);assert.equal(r.bonus.remaining,3);assert.equal(r.credentials,undefined);assert.equal(m.calls.length,2);
});
test("pending first grant preserves the one-time credentials and never claims verification",async()=>{
 const m=mock([{ok:true,account:{created:true},credentials:{password:"Time-12345678"},bonus_pending:true,bonus_error:"Pending"}]);
 const r=await grantTesterAccount({email:"time@example.com",env,fetchImpl:m.fetchImpl});assert.equal(r.verified,false);assert.equal(r.credentials.password,"Time-12345678");assert.equal(m.calls.length,1);
});
test("failed follow-up preserves the one-time password for the authorized operator",async()=>{
 const m=mock([{ok:true,account:{created:true},credentials:{password:"Time-12345678"},bonus},{status:503,body:{ok:false,error:"Unavailable"}}]);
 const r=await grantTesterAccount({email:"time@example.com",env,fetchImpl:m.fetchImpl});assert.equal(r.verified,false);assert.equal(r.credentials.password,"Time-12345678");assert.ok(r.verification_error);
});
test("invalid input and port are rejected without a request",async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;throw Error("Unexpected");};
 await assert.rejects(grantTesterAccount({email:"invalid",env,fetchImpl}),/e-mail/);
 await assert.rejects(grantTesterAccount({email:"time@example.com",env:{...env,PORT:"443/other"},fetchImpl}),/porta/);
 assert.equal(calls,0);
});
test("new account without one-time credentials cannot be reported as verified",async()=>{
 const m=mock([{ok:true,account:{created:true},bonus}]);
 const r=await grantTesterAccount({email:"time@example.com",env,fetchImpl:m.fetchImpl});assert.equal(r.verified,false);assert.ok(r.verification_error);assert.equal(m.calls.length,1);
});

