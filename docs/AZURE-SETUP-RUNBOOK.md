# Azure setup runbook (step by step)

Goal: stand up the Azure resources the designer skill uses (Azure OpenAI +
Azure AI Speech), plus a **Contributor service principal scoped to one resource
group**, and store every value in GCP Secret Manager so the skill picks them up
automatically.

You'll use **two** browser shells (no installs needed):
- **Azure Cloud Shell** → https://shell.azure.com  (pick **Bash** if asked)
- **Google Cloud Shell** → https://shell.cloud.google.com

⚠️ **Never paste the keys into chat.** They go from the Azure output straight
into the gcloud commands. Treat the values like passwords.

---

## PART A — in Azure Cloud Shell (https://shell.azure.com)

### A1. Set names + region, and capture your subscription id
```bash
# A globally-unique suffix so resource names don't collide
SUFFIX=$RANDOM
RG="rg-claude-designer"
REGION="eastus2"                     # supports gpt-image-1, gpt-4o, and Sora
AOAI="octhealth-aoai-$SUFFIX"        # Azure OpenAI resource name
SPEECH="octhealth-speech-$SUFFIX"    # Azure AI Speech resource name

SUB=$(az account show --query id -o tsv)
echo "Subscription: $SUB"            # if blank, run:  az login   (then re-run)
```
> If you have more than one subscription: `az account list -o table`, then
> `az account set --subscription "<the one you want>"`, then re-run the `SUB=` line.

### A2. Make sure the provider is registered (one-time)
```bash
# Check first — on most subscriptions this is already "Registered".
az provider show --namespace Microsoft.CognitiveServices --query registrationState -o tsv
```
If that prints `Registered`, skip ahead to A3. Otherwise register it:
```bash
az provider register --namespace Microsoft.CognitiveServices
# Returns immediately. Re-run the status line above until it says "Registered"
# (can take a few minutes).
```
> Don't use `az provider register --wait` — it blocks silently with no output
> and looks frozen. The check-then-poll approach above is clearer.

### A3. Create the resource group (the single "box" the SP will be scoped to)
```bash
az group create --name "$RG" --location "$REGION"
```

### A4. Create the Azure OpenAI resource
```bash
az cognitiveservices account create \
  --name "$AOAI" --resource-group "$RG" --location "$REGION" \
  --kind OpenAI --sku S0 --custom-domain "$AOAI" --yes
```

### A5. See which models you can deploy in this region
```bash
az cognitiveservices account list-models \
  --name "$AOAI" --resource-group "$RG" \
  --query "[].{model:name, version:version, format:format}" -o table
```
Note the exact **version** strings shown for `gpt-image-1`, `gpt-4o`, and
`sora` (or `sora-2`). Plug them into A6.

### A6. Deploy the three models (versions confirmed in eastus2, Jun 2026)
```bash
# Image model (the proven path the skill's code targets)
az cognitiveservices account deployment create --name "$AOAI" -g "$RG" \
  --deployment-name gpt-image-1 --model-name gpt-image-1 \
  --model-version 2025-04-15 --model-format OpenAI \
  --sku-name GlobalStandard --sku-capacity 1

# Vision / review model
az cognitiveservices account deployment create --name "$AOAI" -g "$RG" \
  --deployment-name gpt-4o --model-name gpt-4o \
  --model-version 2024-11-20 --model-format OpenAI \
  --sku-name GlobalStandard --sku-capacity 10

# Sora 2 video (newest build)
az cognitiveservices account deployment create --name "$AOAI" -g "$RG" \
  --deployment-name sora-2 --model-name sora-2 \
  --model-version 2025-12-08 --model-format OpenAI \
  --sku-name GlobalStandard --sku-capacity 1
```
> Always verify with A5 first — version strings change over time. If a
> deployment errors on `GlobalStandard`, retry that line with `--sku-name
> Standard` (drop `--sku-capacity`). The deployment NAME you choose is what goes
> in the matching `azure-openai-*-deployment` secret (here: `gpt-image-1`,
> `gpt-4o`, `sora-2`).
> Upgrade path (optional, after first validation): eastus2 also has
> `gpt-image-2` and `gpt-4.1`/`gpt-5.x` — deploy those and repoint the secrets
> once the proven path works.

### A6b. If deployment fails with `InsufficientQuota` (limit is 0)
Common on new/grant/sponsorship subscriptions — model quota starts at 0 and must
be requested. It's not a mistake; the deploy commands are valid.
- **Try the regional `Standard` SKU** for gpt-4o (separate bucket from
  GlobalStandard, often nonzero by default):
  `... --deployment-name gpt-4o --model-name gpt-4o --model-version 2024-11-20 --model-format OpenAI --sku-name Standard --sku-capacity 10`
- **See your quota:** `az cognitiveservices usage list --location eastus2 -o table`
- **Request quota** in Azure AI Foundry → https://ai.azure.com → Management
  center → Quota (filter to your subscription + East US 2). Request small amounts
  (gpt-image-1 ~2 RPM, gpt-4o ~30k TPM, sora-2 ~1 RPM). Standard-model bumps
  often auto-approve in minutes; image/Sora may need review.
- Fallback: Azure Portal → Help + Support → support request → "Service and
  subscription limits (quotas)" → Cognitive Services / Azure OpenAI.
- The image + avatar paths don't need Sora, so a stuck Sora quota doesn't block you.

### A7. Create the Azure AI Speech resource (for TTS-Avatar)
```bash
az cognitiveservices account create \
  --name "$SPEECH" --resource-group "$RG" --location "$REGION" \
  --kind SpeechServices --sku S0 --yes
```

### A8. Create the Contributor service principal (scoped to ONLY this RG)
```bash
az ad sp create-for-rbac \
  --name "claude-designer-contributor" \
  --role "Contributor" \
  --scopes "/subscriptions/$SUB/resourceGroups/$RG"
```
This prints a JSON block — copy the `appId`, `password`, and `tenant`. You'll
need them in Part B. (This is the only thing that can change resources, and only
inside `$RG`. Revoke anytime with `az ad sp delete --id <appId>`.)

### A9. Print every value you'll paste into Part B
```bash
echo "AZURE_OPENAI_ENDPOINT = $(az cognitiveservices account show -n "$AOAI" -g "$RG" --query properties.endpoint -o tsv)"
echo "AZURE_OPENAI_API_KEY  = $(az cognitiveservices account keys list -n "$AOAI" -g "$RG" --query key1 -o tsv)"
echo "AZURE_SPEECH_KEY      = $(az cognitiveservices account keys list -n "$SPEECH" -g "$RG" --query key1 -o tsv)"
echo "AZURE_SPEECH_REGION   = $REGION"
echo "AZURE_SUBSCRIPTION_ID = $SUB"
echo "Deployments: gpt-image-1 / gpt-4o / sora (whichever you deployed)"
```
Keep this output handy (and private) for the next part.

---

## PART B — in Google Cloud Shell (https://shell.cloud.google.com)

Substitute the values you captured in Part A. (Org admin only — the SA can read
secrets but not create them.)

```bash
gcloud config set project otchealth-shared-prod

# Azure OpenAI (data plane)
printf '%s' "<AZURE_OPENAI_ENDPOINT>"  | gcloud secrets create azure-openai-endpoint          --data-file=-
printf '%s' "<AZURE_OPENAI_API_KEY>"   | gcloud secrets create azure-openai-key               --data-file=-
printf '%s' "gpt-image-1"              | gcloud secrets create azure-openai-image-deployment  --data-file=-
printf '%s' "gpt-4o"                   | gcloud secrets create azure-openai-vision-deployment --data-file=-
printf '%s' "sora-2"                   | gcloud secrets create azure-openai-video-deployment  --data-file=-

# Azure AI Speech (TTS-Avatar)
printf '%s' "<AZURE_SPEECH_KEY>"       | gcloud secrets create azure-speech-key               --data-file=-
printf '%s' "<AZURE_SPEECH_REGION>"    | gcloud secrets create azure-speech-region            --data-file=-

# Contributor service principal (provisioning)
printf '%s' "<appId>"                  | gcloud secrets create azure-sp-client-id             --data-file=-
printf '%s' "<password>"               | gcloud secrets create azure-sp-client-secret         --data-file=-
printf '%s' "<tenant>"                 | gcloud secrets create azure-sp-tenant-id             --data-file=-
printf '%s' "<AZURE_SUBSCRIPTION_ID>"  | gcloud secrets create azure-subscription-id          --data-file=-
```
> To update a value later (no code change — picks up `latest`):
> `printf '%s' "<NEW>" | gcloud secrets versions add <secret-id> --data-file=-`
> Skip the `sora` line if you didn't deploy it.

---

## PART C — tell Claude

Say "Azure keys are in." Claude will then, in a fresh session:
1. Confirm the skill picked up the keys (`AZURE_OPENAI: loaded`).
2. Run a real `gpt-image-1` + GPT-4o-Vision smoke test via `--provider azure`.
3. Validate the Sora + TTS-Avatar engines with one live render each, fixing any
   API drift the same way Veo 3.1 was validated.

---

## Notes
- **Cost:** creating the resources costs ~nothing; you pay per call, against the
  $5k grant. Delete everything at once with `az group delete --name rg-claude-designer`.
- **Security:** Contributor is scoped to one RG; the SP can't touch anything else,
  and is never Global Admin / account-level. Keys live only in the vault.
- **PHI:** these resources are NON-PHI. Don't put patient data through them.
- **Sora caveat:** Azure's Sora API is mid-transition (model retiring Feb 2026,
  path migrating). If A5 doesn't list a Sora model in `eastus2`, deploy it later
  or in another region — the image + avatar paths don't depend on it.
