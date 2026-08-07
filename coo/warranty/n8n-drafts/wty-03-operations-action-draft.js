import { workflow, node, trigger, sticky, expr } from '@n8n/workflow-sdk';

const syntheticInput = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Synthetic Input', position: [240, 300] },
  output: [{"source_event_id":"syn_evt_004","claim_ref":"clm_SYNTHETIC","action_type":"INVENTORY_RESERVE","safety_clearance":"NOT_VERIFIED","synthetic":true}]
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
          { id: "wty-03-operations-action-draft-0", name: "workflow_code", value: "WTY_03_OPERATIONS_ACTION_DRAFT", type: "string" },
          { id: "wty-03-operations-action-draft-1", name: "mode", value: "synthetic_draft", type: "string" },
          { id: "wty-03-operations-action-draft-2", name: "synthetic", value: true, type: "boolean" },
          { id: "wty-03-operations-action-draft-3", name: "source_event_id", value: expr("{{ $json.source_event_id ?? \"syn_evt_missing\" }}"), type: "string" },
          { id: "wty-03-operations-action-draft-4", name: "input_digest", value: "sha256:synthetic-fixture-only", type: "string" },
          { id: "wty-03-operations-action-draft-5", name: "external_call_count", value: 0, type: "number" },
          { id: "wty-03-operations-action-draft-6", name: "authorization_consumed", value: false, type: "boolean" },
          { id: "wty-03-operations-action-draft-7", name: "claim_ref", value: expr("{{ $json.claim_ref ?? \"clm_SYNTHETIC\" }}"), type: "string" },
          { id: "wty-03-operations-action-draft-8", name: "action_type", value: expr("{{ $json.action_type ?? \"INVENTORY_RESERVE\" }}"), type: "string" },
          { id: "wty-03-operations-action-draft-9", name: "safety_clearance", value: expr("{{ $json.safety_clearance ?? \"NOT_VERIFIED\" }}"), type: "string" },
          { id: "wty-03-operations-action-draft-10", name: "provider_call_permitted", value: false, type: "boolean" },
          { id: "wty-03-operations-action-draft-11", name: "status", value: "AWAITING_HUMAN", type: "string" },
          { id: "wty-03-operations-action-draft-12", name: "outcome", value: "OPERATIONS_ACTION_DRAFT_ONLY", type: "string" }
      ] }
    }
  },
  output: [{"workflow_code":"WTY_03_OPERATIONS_ACTION_DRAFT","mode":"synthetic_draft","synthetic":true,"input_digest":"sha256:synthetic-fixture-only","external_call_count":0,"authorization_consumed":false,"provider_call_permitted":false,"status":"AWAITING_HUMAN","outcome":"OPERATIONS_ACTION_DRAFT_ONLY","source_event_id":"syn_evt_004","claim_ref":"clm_SYNTHETIC","action_type":"INVENTORY_RESERVE","safety_clearance":"NOT_VERIFIED"}]
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
        { id: "wty-03-operations-action-draft-floor-1", name: 'draft_only', value: true, type: 'boolean' },
        { id: "wty-03-operations-action-draft-floor-2", name: 'live_execution_permitted', value: false, type: 'boolean' },
        { id: "wty-03-operations-action-draft-floor-3", name: 'customer_contact_permitted', value: false, type: 'boolean' }
      ] }
    }
  },
  output: [{...{"workflow_code":"WTY_03_OPERATIONS_ACTION_DRAFT","mode":"synthetic_draft","synthetic":true,"input_digest":"sha256:synthetic-fixture-only","external_call_count":0,"authorization_consumed":false,"provider_call_permitted":false,"status":"AWAITING_HUMAN","outcome":"OPERATIONS_ACTION_DRAFT_ONLY","source_event_id":"syn_evt_004","claim_ref":"clm_SYNTHETIC","action_type":"INVENTORY_RESERVE","safety_clearance":"NOT_VERIFIED"},draft_only:true,live_execution_permitted:false,customer_contact_permitted:false}]
});

const scopeNote = sticky("## DISABLED SYNTHETIC DRAFT ONLY\nThe workflow has no Shopify, WMS, carrier, repair, payment, or HTTP node. It cannot consume authorization or create a provider command.", [syntheticInput, draftOnlyResult, authorityFloor], { color: 5 });

export default workflow("wty-03-operations-action-draft", "WTY-03 Operations Action \u2014 Synthetic Draft")
  .add(syntheticInput)
  .to(draftOnlyResult)
  .to(authorityFloor)
  .add(scopeNote);
