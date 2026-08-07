import { workflow, node, trigger, sticky, expr } from '@n8n/workflow-sdk';

const syntheticInput = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Synthetic Input', position: [240, 300] },
  output: [{"source_event_id":"syn_evt_005","provider":"mock_carrier","observation_type":"label_created","provider_event_ref":"prov_SYNTHETIC","synthetic":true}]
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
          { id: "wty-04-provider-event-normalize-0", name: "workflow_code", value: "WTY_04_PROVIDER_EVENT_NORMALIZE", type: "string" },
          { id: "wty-04-provider-event-normalize-1", name: "mode", value: "synthetic_draft", type: "string" },
          { id: "wty-04-provider-event-normalize-2", name: "synthetic", value: true, type: "boolean" },
          { id: "wty-04-provider-event-normalize-3", name: "source_event_id", value: expr("{{ $json.source_event_id ?? \"syn_evt_missing\" }}"), type: "string" },
          { id: "wty-04-provider-event-normalize-4", name: "input_digest", value: "sha256:synthetic-fixture-only", type: "string" },
          { id: "wty-04-provider-event-normalize-5", name: "external_call_count", value: 0, type: "number" },
          { id: "wty-04-provider-event-normalize-6", name: "authorization_consumed", value: false, type: "boolean" },
          { id: "wty-04-provider-event-normalize-7", name: "provider", value: expr("{{ $json.provider ?? \"mock_carrier\" }}"), type: "string" },
          { id: "wty-04-provider-event-normalize-8", name: "observation_type", value: expr("{{ $json.observation_type ?? \"label_created\" }}"), type: "string" },
          { id: "wty-04-provider-event-normalize-9", name: "provider_event_ref", value: expr("{{ $json.provider_event_ref ?? \"prov_SYNTHETIC\" }}"), type: "string" },
          { id: "wty-04-provider-event-normalize-10", name: "authoritative_observation_only", value: true, type: "boolean" },
          { id: "wty-04-provider-event-normalize-11", name: "domain_transition_applied", value: false, type: "boolean" },
          { id: "wty-04-provider-event-normalize-12", name: "outcome", value: "PROVIDER_OBSERVATION_DRAFT_ONLY", type: "string" }
      ] }
    }
  },
  output: [{"workflow_code":"WTY_04_PROVIDER_EVENT_NORMALIZE","mode":"synthetic_draft","synthetic":true,"input_digest":"sha256:synthetic-fixture-only","external_call_count":0,"authorization_consumed":false,"authoritative_observation_only":true,"domain_transition_applied":false,"outcome":"PROVIDER_OBSERVATION_DRAFT_ONLY","source_event_id":"syn_evt_005","provider":"mock_carrier","observation_type":"label_created","provider_event_ref":"prov_SYNTHETIC"}]
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
        { id: "wty-04-provider-event-normalize-floor-1", name: 'draft_only', value: true, type: 'boolean' },
        { id: "wty-04-provider-event-normalize-floor-2", name: 'live_execution_permitted', value: false, type: 'boolean' },
        { id: "wty-04-provider-event-normalize-floor-3", name: 'customer_contact_permitted', value: false, type: 'boolean' }
      ] }
    }
  },
  output: [{...{"workflow_code":"WTY_04_PROVIDER_EVENT_NORMALIZE","mode":"synthetic_draft","synthetic":true,"input_digest":"sha256:synthetic-fixture-only","external_call_count":0,"authorization_consumed":false,"authoritative_observation_only":true,"domain_transition_applied":false,"outcome":"PROVIDER_OBSERVATION_DRAFT_ONLY","source_event_id":"syn_evt_005","provider":"mock_carrier","observation_type":"label_created","provider_event_ref":"prov_SYNTHETIC"},draft_only:true,live_execution_permitted:false,customer_contact_permitted:false}]
});

const scopeNote = sticky("## DISABLED SYNTHETIC DRAFT ONLY\nProvider events are observations, never commands. Label created never means shipped. No live webhook, HTTP request, database, or provider node is present.", [syntheticInput, draftOnlyResult, authorityFloor], { color: 5 });

export default workflow("wty-04-provider-event-normalize", "WTY-04 Provider Event Normalize \u2014 Synthetic Draft")
  .add(syntheticInput)
  .to(draftOnlyResult)
  .to(authorityFloor)
  .add(scopeNote);
