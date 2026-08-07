import { workflow, node, trigger, sticky, expr } from '@n8n/workflow-sdk';

const syntheticInput = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Synthetic Input', position: [240, 300] },
  output: [{"source_event_id":"syn_evt_006","exception_type":"provider_success_after_timeout","owner_role":"Warranty Operations Lead","severity":"S1","synthetic":true}]
});

const draftOnlyResult = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Build Draft-Only Result',
    position: [560, 300],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: { assignments: [
          { id: "wty-05-reconciliation-exception-draft-0", name: "workflow_code", value: "WTY_05_RECONCILIATION_EXCEPTION_DRAFT", type: "string" },
          { id: "wty-05-reconciliation-exception-draft-1", name: "mode", value: "synthetic_draft", type: "string" },
          { id: "wty-05-reconciliation-exception-draft-2", name: "synthetic", value: true, type: "boolean" },
          { id: "wty-05-reconciliation-exception-draft-3", name: "source_event_id", value: expr("{{ $json.source_event_id ?? \"syn_evt_missing\" }}"), type: "string" },
          { id: "wty-05-reconciliation-exception-draft-4", name: "input_digest", value: "sha256:synthetic-fixture-only", type: "string" },
          { id: "wty-05-reconciliation-exception-draft-5", name: "external_call_count", value: 0, type: "number" },
          { id: "wty-05-reconciliation-exception-draft-6", name: "authorization_consumed", value: false, type: "boolean" },
          { id: "wty-05-reconciliation-exception-draft-7", name: "exception_type", value: expr("{{ $json.exception_type ?? \"provider_success_after_timeout\" }}"), type: "string" },
          { id: "wty-05-reconciliation-exception-draft-8", name: "owner_role", value: expr("{{ $json.owner_role ?? \"Warranty Operations Lead\" }}"), type: "string" },
          { id: "wty-05-reconciliation-exception-draft-9", name: "severity", value: expr("{{ $json.severity ?? \"S1\" }}"), type: "string" },
          { id: "wty-05-reconciliation-exception-draft-10", name: "auto_repair_permitted", value: false, type: "boolean" },
          { id: "wty-05-reconciliation-exception-draft-11", name: "status", value: "OPEN_FOR_HUMAN_REVIEW", type: "string" },
          { id: "wty-05-reconciliation-exception-draft-12", name: "outcome", value: "RECONCILIATION_EXCEPTION_DRAFT_ONLY", type: "string" }
      ] }
    }
  },
  output: [{"workflow_code":"WTY_05_RECONCILIATION_EXCEPTION_DRAFT","mode":"synthetic_draft","synthetic":true,"input_digest":"sha256:synthetic-fixture-only","external_call_count":0,"authorization_consumed":false,"auto_repair_permitted":false,"status":"OPEN_FOR_HUMAN_REVIEW","outcome":"RECONCILIATION_EXCEPTION_DRAFT_ONLY","source_event_id":"syn_evt_006","exception_type":"provider_success_after_timeout","owner_role":"Warranty Operations Lead","severity":"S1"}]
});

const authorityFloor = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Enforce Synthetic Authority Floor',
    position: [880, 300],
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: { assignments: [
        { id: "wty-05-reconciliation-exception-draft-floor-1", name: 'draft_only', value: true, type: 'boolean' },
        { id: "wty-05-reconciliation-exception-draft-floor-2", name: 'live_execution_permitted', value: false, type: 'boolean' },
        { id: "wty-05-reconciliation-exception-draft-floor-3", name: 'customer_contact_permitted', value: false, type: 'boolean' }
      ] }
    }
  },
  output: [{...{"workflow_code":"WTY_05_RECONCILIATION_EXCEPTION_DRAFT","mode":"synthetic_draft","synthetic":true,"input_digest":"sha256:synthetic-fixture-only","external_call_count":0,"authorization_consumed":false,"auto_repair_permitted":false,"status":"OPEN_FOR_HUMAN_REVIEW","outcome":"RECONCILIATION_EXCEPTION_DRAFT_ONLY","source_event_id":"syn_evt_006","exception_type":"provider_success_after_timeout","owner_role":"Warranty Operations Lead","severity":"S1"},draft_only:true,live_execution_permitted:false,customer_contact_permitted:false}]
});

const scopeNote = sticky("## DISABLED SYNTHETIC DRAFT ONLY\nReconciliation detects and owns exceptions; it never mutates canonical state or repeats a side effect. This workflow contains no schedule, credential, external call, or persistence node.", [syntheticInput, draftOnlyResult, authorityFloor], { color: 5 });

export default workflow("wty-05-reconciliation-exception-draft", "WTY-05 Reconciliation Exception \u2014 Synthetic Draft")
  .add(syntheticInput)
  .to(draftOnlyResult)
  .to(authorityFloor)
  .add(scopeNote);
