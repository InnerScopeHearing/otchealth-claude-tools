import { workflow, node, trigger, sticky, expr } from '@n8n/workflow-sdk';

const syntheticInput = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Synthetic Input', position: [240, 300] },
  output: [{"source_event_id":"syn_evt_001","event_type":"warranty.claim.received","schema_version":1,"synthetic":true}]
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
          { id: "wty-00-signed-event-intake-router-0", name: "workflow_code", value: "WTY_00_SIGNED_EVENT_INTAKE_ROUTER", type: "string" },
          { id: "wty-00-signed-event-intake-router-1", name: "mode", value: "synthetic_draft", type: "string" },
          { id: "wty-00-signed-event-intake-router-2", name: "synthetic", value: true, type: "boolean" },
          { id: "wty-00-signed-event-intake-router-3", name: "source_event_id", value: expr("{{ $json.source_event_id ?? \"syn_evt_missing\" }}"), type: "string" },
          { id: "wty-00-signed-event-intake-router-4", name: "input_digest", value: "sha256:synthetic-fixture-only", type: "string" },
          { id: "wty-00-signed-event-intake-router-5", name: "external_call_count", value: 0, type: "number" },
          { id: "wty-00-signed-event-intake-router-6", name: "authorization_consumed", value: false, type: "boolean" },
          { id: "wty-00-signed-event-intake-router-7", name: "signature_status", value: "synthetic_valid", type: "string" },
          { id: "wty-00-signed-event-intake-router-8", name: "schema_status", value: "accepted_v1", type: "string" },
          { id: "wty-00-signed-event-intake-router-9", name: "payload_scan", value: "opaque_ids_only", type: "string" },
          { id: "wty-00-signed-event-intake-router-10", name: "event_type", value: expr("{{ $json.event_type ?? \"warranty.claim.received\" }}"), type: "string" },
          { id: "wty-00-signed-event-intake-router-11", name: "outcome", value: "ROUTED_TO_DRAFT_ONLY", type: "string" }
      ] }
    }
  },
  output: [{"workflow_code":"WTY_00_SIGNED_EVENT_INTAKE_ROUTER","mode":"synthetic_draft","synthetic":true,"input_digest":"sha256:synthetic-fixture-only","external_call_count":0,"authorization_consumed":false,"signature_status":"synthetic_valid","schema_status":"accepted_v1","payload_scan":"opaque_ids_only","outcome":"ROUTED_TO_DRAFT_ONLY","source_event_id":"syn_evt_001","event_type":"warranty.claim.received"}]
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
        { id: "wty-00-signed-event-intake-router-floor-1", name: 'draft_only', value: true, type: 'boolean' },
        { id: "wty-00-signed-event-intake-router-floor-2", name: 'live_execution_permitted', value: false, type: 'boolean' },
        { id: "wty-00-signed-event-intake-router-floor-3", name: 'customer_contact_permitted', value: false, type: 'boolean' }
      ] }
    }
  },
  output: [{...{"workflow_code":"WTY_00_SIGNED_EVENT_INTAKE_ROUTER","mode":"synthetic_draft","synthetic":true,"input_digest":"sha256:synthetic-fixture-only","external_call_count":0,"authorization_consumed":false,"signature_status":"synthetic_valid","schema_status":"accepted_v1","payload_scan":"opaque_ids_only","outcome":"ROUTED_TO_DRAFT_ONLY","source_event_id":"syn_evt_001","event_type":"warranty.claim.received"},draft_only:true,live_execution_permitted:false,customer_contact_permitted:false}]
});

const scopeNote = sticky("## DISABLED SYNTHETIC DRAFT ONLY\nSynthetic contract only. Reject real customer data. No external nodes, credentials, provider calls, messages, approvals, authorizations, or canonical state changes.", [syntheticInput, draftOnlyResult, authorityFloor], { color: 5 });

export default workflow("wty-00-signed-event-intake-router", "WTY-00 Signed Event Intake and Router \u2014 Synthetic Draft")
  .add(syntheticInput)
  .to(draftOnlyResult)
  .to(authorityFloor)
  .add(scopeNote);
