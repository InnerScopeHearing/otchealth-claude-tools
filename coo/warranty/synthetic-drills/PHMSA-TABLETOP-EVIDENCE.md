# Safety / PHMSA Hazardous-Return Tabletop Evidence

Prepared: 2026-08-08
Mode: research-backed tabletop only
Operational decision: HOLD / NO-GO unchanged

## Official source rules used

1. PHMSA states that lithium batteries are regulated hazardous materials under 49 CFR Parts 171-180 and that damaged, defective, or recalled batteries have greater short-circuit, heat, and fire risk. Shippers must assess the fire hazard and comply with the Hazardous Materials Regulations. Source: [PHMSA - Transporting Lithium Batteries](https://www.phmsa.dot.gov/lithiumbatteries).
2. PHMSA's 2024 shipper guide states that damaged, defective, or recalled lithium cells/batteries that may produce dangerous heat, fire, or short circuit may travel only by highway, rail, or vessel and are strictly forbidden by aircraft. It summarizes 49 CFR 173.185(f) packaging: one battery in individual non-metallic inner packaging, non-combustible/electrically non-conductive/absorbent cushioning, Packing Group I outer packaging, damaged/defective marking, and full training/shipping-paper/marking/labeling obligations. Source: [PHMSA Lithium Battery Guide for Shippers, 2024](https://www.phmsa.dot.gov/sites/phmsa.dot.gov/files/2024-11/Lithium-Battery-Guide-2024.pdf).
3. PHMSA's DDR guide states the shipper is responsible for condition assessment, may need a technical expert/manufacturer information, and must treat suspected DDR batteries as fully regulated. Source: [PHMSA DDR Lithium Battery Guide](https://www.phmsa.dot.gov/sites/phmsa.dot.gov/files/2023-03/DDR-brochure.pdf).
4. USPS Publication 52 states damaged, defective, or recalled batteries are prohibited unless approved by the USPS Director, Product Classification. Used/damaged/defective devices are restricted to surface transportation under the applicable domestic conditions; damaged/defective/recalled lithium batteries and devices are prohibited internationally. Sources: [USPS Publication 52 section 349](https://pe.usps.com/text/pub52/pub52c3_028.htm), [USPS Packaging Instruction 9D](https://pe.usps.com/text/pub52/pub52apxc_032.htm), and [USPS section 622.5](https://pe.usps.com/text/pub52/pub52c6_005.htm).

## Tabletop decision tree executed

| Synthetic signal | Agent-side action | Prohibited agent action | Required human/physical next step |
|---|---|---|---|
| Heat during charging | Create Safety Hold requirement; stop ordinary troubleshooting and ordinary label route | Do not classify battery, create label, instruct destructive handling, or close Safety | Product Safety assesses condition and custody; trained hazmat shipper determines whether DDR; approved carrier confirms route |
| Smoke or fire | Immediate stop-use/Safety escalation; block ordinary parcel/air route | Do not ship by air, issue ordinary return label, or authorize customer packaging | Emergency/safety script from approved owner; human reportability decision; carrier/hazmat route and chain of custody |
| Swelling or leakage | Treat as suspected DDR; ordinary return and returnless handling blocked | Do not ask customer to open, remove, discharge, pierce, tape, or destroy battery | Technical/Product Safety assessment; compliant packaging and ground/rail/vessel carrier acceptance if transport is authorized |
| Pain or injury without known battery damage | Safety route first; no ordinary claim closure | Do not make medical, reportability, recall, or closure decision | Product Safety and Legal decide reportability/recall; customer receives approved immediate safety guidance |
| Recall or lot concern | Draft lot/serial hold and recall investigation requirement | Do not execute inventory hold, send recall notice, or decide affected population | Named Safety human executes holds and reconciles inventory/customer scope; Legal/Safety release communications |

## Tabletop result

PASS_TABLETOP_ONLY:

- Safety-positive cases cannot continue through ordinary Care, troubleshooting, label, returnless, or closure paths.
- Suspected damaged/defective/recalled lithium batteries cannot receive an air route.
- USPS cannot be assumed available for a DDR return; its published default is prohibition absent Product Classification approval.
- No generic prepaid return label can be created until product condition, packaging authority, carrier service, return location, shipper training, paperwork, markings/labels, and chain-of-custody ownership are approved.
- The agent may identify triggers, preserve facts, draft holds, display approved scripts, and route to humans. It may not classify a battery, package it, select a carrier service, offer it for transport, decide reportability, execute lot/serial holds, or close Safety.

## Irreducible evidence still required

1. Named Product Safety primary, secondary, and 24/7 duty rota with acknowledgment targets.
2. Approved stop-use, emergency, reportability, recall, customer-contact, and no-return scripts.
3. Named trained hazmat shipper and current training record covering 49 CFR requirements.
4. Product/OEM battery specifications and DDR assessment criteria validated by a qualified technical person.
5. Approved packaging source and instructions, including any DOT Special Permit terms if used.
6. Carrier account and written service acceptance for the exact damaged/defective device route; no-air controls.
7. Primary and backup return locations capable of controlled receipt and quarantine.
8. Chain-of-custody, lot/serial hold, incident/reporting, inspection, and disposition forms.
9. Observed end-to-end drill using a nonhazardous dummy device: Safety trigger, page/acknowledgment, classification handoff, hold, packaging selection, carrier route selection, simulated tender, facility check-in, quarantine, reconciliation, and after-action closure.

No physical shipment, label, provider call, customer message, hold execution, or Safety closure occurred in this tabletop.