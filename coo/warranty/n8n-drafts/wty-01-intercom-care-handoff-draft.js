import { workflow, node, trigger, sticky, expr } from '@n8n/workflow-sdk';

const syntheticInput = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Synthetic Input', position: [240, 300] },
  output: [{"source_event_id":"syn_evt_002","claim_ref":"clm_SYNTHETIC","safe_status":"UNDER_REVIEW","safety_flag":false,"synthetic":true}]
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
          { id: "wty-01-intercom-care-handoff-draft-0", name: "workflow_code", value: "WTY_01_INTERCOM_CARE_HANDOFF_DRAFT", type: "string" },
          { id: "wty-01-intercom-care-handoff-draft-1", name: "mode", value: "synthetic_draft", type: "string" },
          { id: "wty-01-intercom-care-handoff-draft-2", name: "synthetic", value: true, type: "boolean" },
          { id: "wty-01-intercom-care-handoff-draft-3", name: "source_event_id", value: expr("{{ $json.source_event_id ?? \"syn_evt_missing\" }}"), type: "string" },
          { id: "wty-01-intercom-care-handoff-draft-4", name: "input_digest", value: "sha256:synthetic-fixture-only", type: "string" },
          { id: "wty-01-intercom-care-handoff-draft-5", name: "external_call_count", value: 0, type: "number" },
          { id: "wty-01-intercom-care-handoff-draft-6", name: "authorization_consumed", value: false, type: "boolean" },
          { id: "wty-01-intercom-care-handoff-draft-7", name: "workspace_ref", value: "budq9yib", type: "string" },
          { id: "wty-01-intercom-care-handoff-draft-8", name: "claim_ref", value: expr("{{ $json.claim_ref ?? \"clm_SYNTHETIC\" }}"), type: "string" },
          { id: "wty-01-intercom-care-handoff-draft-9", name: "safe_status", value: expr("{{ $json.safe_status ?? \"UNDER_REVIEW\" }}"), type: "string" },
          { id: "wty-01-intercom-care-handoff-draft-10", name: "target_team", value: expr("{{ $json.safety_flag === true ? \"Safety Escalations\" : \"Care Team\" }}"), type: "string" },
          { id: "wty-01-intercom-care-handoff-draft-11", name: "proposed_ticket_type", value: "Warranty Claim", type: "string" },
          { id: "wty-01-intercom-care-handoff-draft-12", name: "outcome", value: "INTERCOM_ACTION_DRAFT_ONLY", type: "string" }
      ] }
    }
  },
  output: [{"workflow_code":"WTY_01_INTERCOM_CARE_HANDOFF_DRAFT","mode":"synthetic_draft","synthetic":true,"input_digest":"sha256:synthetic-fixture-only","external_call_count":0,"authorization_consumed":false,"workspace_ref":"budq9yib","proposed_ticket_type":"Warranty Claim","outcome":"INTERCOM_ACTION_DRAFT_ONLY","source_event_id":"syn_evt_002","claim_ref":"clm_SYNTHETIC","safe_status":"UNDER_REVIEW","target_team":"SYNTHETIC"}]
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
        { id: "wty-01-intercom-care-handoff-draft-floor-1", name: 'draft_only', value: true, type: 'boolean' },
        { id: "wty-01-intercom-care-handoff-draft-floor-2", name: 'live_execution_permitted', value: false, type: 'boolean' },
        { id: "wty-01-intercom-care-handoff-draft-floor-3", name: 'customer_contact_permitted', value: false, type: 'boolean' }
      ] }
    }
  },
  output: [{...{"workflow_code":"WTY_01_INTERCOM_CARE_HANDOFF_DRAFT","mode":"synthetic_draft","synthetic":true,"input_digest":"sha256:synthetic-fixture-only","external_call_count":0,"authorization_consumed":false,"workspace_ref":"budq9yib","proposed_ticket_type":"Warranty Claim","outcome":"INTERCOM_ACTION_DRAFT_ONLY","source_event_id":"syn_evt_002","claim_ref":"clm_SYNTHETIC","safe_status":"UNDER_REVIEW","target_team":"SYNTHETIC"},draft_only:true,live_execution_permitted:false,customer_contact_permitted:false}]
});

const scopeNote = sticky("## DISABLED SYNTHETIC DRAFT ONLY\nNo Intercom credential or node is present. This workflow cannot create a conversation, ticket, tag, note, reply, assignment, closure, or customer message.", [syntheticInput, draftOnlyResult, authorityFloor], { color: 5 });

export default workflow("wty-01-intercom-care-handoff-draft", "WTY-01 Intercom Care Handoff \u2014 Synthetic Draft")
  .add(syntheticInput)
  .to(draftOnlyResult)
  .to(authorityFloor)
  .add(scopeNote);
