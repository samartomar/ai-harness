import assert from 'node:assert/strict';
import {POLICY_APPROVER_EMAIL_PATTERN} from '../../src/org-policy/ecc-mcp-approval.ts';

// GitHub's commit-account association supplies attribution, not a corporate role
// or production authority. These journeys authorize disposable test roots only.
export function resolveHostedOperator(run,commit,source,login){
 assert(typeof source==='string'&&source.length===40&&/^[a-f0-9]{40}$/u.test(source),'exact verifier source required');
 assert.equal(run.head_sha,source);assert.equal(commit.sha,source);
 const actor=run.actor,author=commit.author;
 assert.equal(actor?.type,'User','a human dispatch actor is required');
 assert.equal(author?.type,'User','a GitHub-associated commit author is required');
 assert(typeof login==='string'&&login===login.trim()&&/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(login),'invalid dispatch actor');
 assert.equal(actor.login,login);assert.equal(author.login,login);
 assert(Number.isSafeInteger(actor.id)&&actor.id>0,'native actor identity required');
 assert.equal(author.id,actor.id,'commit author must be the dispatch actor');
 const email=commit.commit?.author?.email;
 assert(typeof email==='string'&&email.length<=254&&!/\s/u.test(email)&&new RegExp(POLICY_APPROVER_EMAIL_PATTERN,'u').test(email),'associated author must have a valid accountable-owner email');
 return {name:login,email,githubActor:login,githubActorId:actor.id,sourceCommit:source,identitySource:'github-associated-commit-author',authority:'self-asserted-disposable-test-operator'};
}
