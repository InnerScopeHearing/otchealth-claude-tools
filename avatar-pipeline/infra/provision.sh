#!/usr/bin/env bash
# Provision the avatar GPU VM. Run in GitHub Actions (after azure/login) or
# locally with an az session that has Contributor on the subscription.
#
# Cost-safety by design:
#  - no public app port is opened; inference is triggered only via run-command
#  - no public IP; SSH is not exposed
#  - data disk persists model weights at /mnt/weights
#  - auto-shutdown deallocates daily as a backstop
#
# Requires GPU quota for the T4 family (NCASv3). If quota is zero, request it in
# the Azure portal under Quotas first (CHECKPOINT 1).
set -euo pipefail

RG="${AZURE_RG:-otchealth-avatar-rg}"
LOC="${AZURE_REGION:-eastus}"
VM="${AZURE_VM_NAME:-otchealth-avatar-gpu}"
SKU="${AZURE_VM_SKU:-Standard_NC4as_T4_v3}"
SHUTDOWN_TIME="${AZURE_AUTOSHUTDOWN_TIME:-0300}"   # local VM time HHMM
DISK_GB="${AZURE_WEIGHTS_DISK_GB:-128}"

echo "== resource group =="
az group create -n "$RG" -l "$LOC" -o none
echo "created/confirmed $RG in $LOC"

echo "== GPU VM (no public IP, no inbound ports) =="
az vm create \
  -g "$RG" -n "$VM" \
  --image Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest \
  --size "$SKU" \
  --public-ip-address "" \
  --nsg-rule NONE \
  --admin-username azureuser \
  --generate-ssh-keys \
  --tags project=otchealth-avatar \
  -o none
echo "VM $VM created"

echo "== weights data disk =="
az vm disk attach -g "$RG" --vm-name "$VM" --name "${VM}-weights" --new --size-gb "$DISK_GB" -o none

echo "== format + mount /mnt/weights, install NVIDIA driver + Docker + nvidia-container-toolkit =="
az vm run-command invoke -g "$RG" -n "$VM" --command-id RunShellScript -o none --scripts '
set -e
# data disk -> /mnt/weights (first unpartitioned disk)
DISK=$(lsblk -dn -o NAME,TYPE | awk "$2==\"disk\"{print $1}" | tail -1)
if ! blkid /dev/${DISK}1 >/dev/null 2>&1; then
  parted -s /dev/$DISK mklabel gpt mkpart primary ext4 0% 100%
  mkfs.ext4 -F /dev/${DISK}1
fi
mkdir -p /mnt/weights
grep -q "/mnt/weights" /etc/fstab || echo "/dev/${DISK}1 /mnt/weights ext4 defaults,nofail 0 2" >> /etc/fstab
mount -a
# NVIDIA driver + container toolkit + docker
if ! command -v nvidia-smi >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ubuntu-drivers-common
  ubuntu-drivers autoinstall
fi
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list
apt-get update && apt-get install -y nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=docker
systemctl restart docker || true
'

echo "== auto-shutdown backstop (deallocate daily at ${SHUTDOWN_TIME}) =="
az vm auto-shutdown -g "$RG" -n "$VM" --time "$SHUTDOWN_TIME" -o none

echo "== deallocate now so we do not bill idle time =="
az vm deallocate -g "$RG" -n "$VM" -o none

echo "PROVISION COMPLETE. Reboot may be required for the GPU driver; the render"
echo "workflow starts the VM and a CUDA check runs on first inference."
