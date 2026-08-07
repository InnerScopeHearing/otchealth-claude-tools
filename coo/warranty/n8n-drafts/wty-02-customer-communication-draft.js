import { workflow, node, trigger, sticky, expr } from '@n8n/workflow-sdk';

const syntheticInput = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Synthetic Input', position: [240, 300] },
  output: [{"source_event_id":"syn_evt_003","claim_ref":"clm_SYNTHETIC","template_code":"WTY_RECEIPT_V0","message_class":"ordinary_transactional","synthetic":true}]
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
          { id: "wty-02-customer-communication-draft-0", name: "workflow_code", value: "WTY_02_CUSTOMER_COMMUNICATION_DRAFT", type: "string" },
          { id: "wty-02-customer-communication-draft-1", name: "mode", value: "synthetic_draft", type: "string" },
          { id: "wty-02-customer-communication-draft-2", name: "synthetic", value: true, type: "boolean" },
          { id: "wty-02-customer-communication-draft-3", name: "source_event_id", value: expr("{{ $json.source_event_id ?? \"syn_evt_missing\" }}"), type: "string" },
          { id: "wty-02-customer-communication-draft-4", name: "input_digest", value: "sha256:synthetic-fixture-only", type: "string" },
          { id: "wty-02-customer-communication-draft-5", name: "external_call_count", value: 0, type: "number" },
          { id: "wty-02-customer-communication-draft-6", name: "authorization_consumed", value: false, type: "boolean" },
          { id: "wty-02-customer-communication-draft-7", name: "claim_ref", value: expr("{{ $json.claim_ref ?? \"clm_SYNTHETIC\" }}"), type: "string" },
          { id: "wty-02-customer-communication-draft-8", name: "template_code", value: expr("{{ $json.template_code ?? \"WTY_RECEIPT_V0\" }}"), type: "string" },
          { id: "wty-02-customer-communication-draft-9", name: "message_class", value: expr("{{ $json.message_class ?? \"ordinary_transactional\" }}"), type: "string" },
          { id: "wty-02-customer-communication-draft-10", name: "recipient_verified", value: false, type: "boolean" },
          { id: "wty-02-customer-communication-draft-11", name: "release_authorization_required", value: true, type: "boolean" },
          { id: "wty-02-customer-communication-draft-12", name: "outcome", value: "MESSAGE_DRAFT_ONLY", type: "string" }
      ] }
    }
  },
  output: [{"workflow_code":"WTY_02_CUSTOMER_COMMUNICATION_DRAFT","mode":"synthetic_draft","synthetic":true,"input_digest":"sha256:synthetic-fixture-only","external_call_count":0,"authorization_consumed":false,"recipient_verified":false,"release_authorization_required":true,"outcome":"MESSAGE_DRAFT_ONLY","source_event_id":"syn_evt_003","claim_ref":"clm_SYNTHETIC","template_code":"WTY_RECEIPT_V0","message_class":"ordinary_transactional"}]
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
        { id: "wty-02-customer-communication-draft-floor-1", name: 'draft_only', value: true, type: 'boolean' },
        { id: "wty-02-customer-communication-draft-floor-2", name: 'live_execution_permitted', value: false, type: 'boolean' },
        { id: "wty-02-customer-communication-draft-floor-3", name: 'customer_contact_permitted', value: false, type: 'boolean' }
      ] }
    }
  },
  output: [{...{"workflow_code":"WTY_02_CUSTOMER_COMMUNICATION_DRAFT","mode":"synthetic_draft","synthetic":true,"input_digest":"sha256:synthetic-fixture-only","external_call_count":0,"authorization_consumed":false,"recipient_verified":false,"release_authorization_required":true,"outcome":"MESSAGE_DRAFT_ONLY","source_event_id":"syn_evt_003","claim_ref":"clm_SYNTHETIC","template_code":"WTY_RECEIPT_V0","message_class":"ordinary_transactional"},draft_only:true,live_execution_permitted:false,customer_contact_permitted:false}]
});

const scopeNote = sticky("## DISABLED SYNTHETIC DRAFT ONLY\nNo outbound channel exists here. Adverse, Safety, recall, bulk, financial, and legal messages require an exact one-use human release authorization in the future Warranty Service.", [syntheticInput, draftOnlyResult, authorityFloor], { color: 5 });

export default workflow("wty-02-customer-communication-draft", "WTY-02 Customer Communication \u2014 Synthetic Draft")
  .add(syntheticInput)
  .to(draftOnlyResult)
  .to(authorityFloor)
  .add(scopeNote);
