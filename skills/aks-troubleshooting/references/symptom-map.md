# Symptom → Investigation Map

Look up the symptom, run the commands in order. Each section is self-contained.

---

## Pod Pending

```bash
kubectl describe pod <pod> -n <ns>         # Check Events for scheduling failure reason
kubectl get events -n <ns> --sort-by='.lastTimestamp' --field-selector involvedObject.name=<pod>
kubectl get nodes -o wide                  # Node count and status
kubectl describe nodes | grep -A5 "Allocated resources"  # Resource pressure
kubectl get pv,pvc -n <ns>                 # PVC binding stuck?
```

Common causes: insufficient CPU/memory, node taints without tolerations, PVC pending, node selector mismatch, subnet IP exhaustion (Azure CNI).

---

## Pod CrashLoopBackOff

```bash
kubectl logs <pod> -n <ns> --all-containers
kubectl logs <pod> -n <ns> --previous --all-containers
kubectl describe pod <pod> -n <ns>         # Check exit codes and restart count
kubectl get events -n <ns> --field-selector involvedObject.name=<pod>
```

Common causes: missing env var / secret, config file not mounted, OOM (check exit code 137), dependency not reachable, liveness probe killing healthy startup.

---

## Node NotReady

```bash
kubectl describe node <node>               # Conditions: MemoryPressure, DiskPressure, PIDPressure
kubectl get events --field-selector involvedObject.name=<node> --sort-by='.lastTimestamp'
az vmss list-instances -g MC_<rg>_<cluster>_<region> --name <vmss> -o table
az vmss get-instance-view -g MC_<rg>_<cluster>_<region> --name <vmss> --instance-id <id>
```

Common causes: kubelet crash, containerd OOM, Azure host maintenance, disk full, NTP drift, CNI plugin crash.

---

## Image Pull Failure (ErrImagePull / ImagePullBackOff)

```bash
kubectl describe pod <pod> -n <ns>         # Image name and pull error in Events
az aks show -g <rg> -n <cluster> --query "identityProfile.kubeletidentity.clientId" -o tsv
az role assignment list --assignee <kubelet-id> --scope <acr-id> -o table
az acr repository show -n <acr> --image <image>:<tag>
```

Common causes: wrong image tag, ACR not attached (`az aks update --attach-acr`), kubelet identity missing AcrPull role, private ACR without private endpoint.

---

## OOMKilled (Exit Code 137)

```bash
kubectl describe pod <pod> -n <ns>         # Last State: OOMKilled
kubectl top pod -n <ns>                    # Current memory usage
kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.containers[*].resources}'
kubectl logs <pod> -n <ns> --previous      # What was happening before OOM
```

Common causes: memory limit too low, memory leak, JVM heap exceeds container limit (set -Xmx), sidecar eating memory.

---

## Service Not Reachable / Connection Refused

```bash
kubectl get svc -n <ns>                    # ClusterIP, ports, selectors
kubectl get endpoints -n <ns>              # Are endpoints populated?
kubectl get pods -n <ns> -l <svc-selector> # Do pods match the selector?
kubectl exec <client-pod> -n <ns> -- curl -v <svc>:<port>/healthz
kubectl get networkpolicies -n <ns>        # Network policy blocking traffic?
```

Common causes: label selector mismatch (no endpoints), target port wrong, network policy denying ingress, pod not Ready.

---

## DNS Resolution Failure

```bash
kubectl exec <pod> -n <ns> -- nslookup kubernetes.default
kubectl exec <pod> -n <ns> -- cat /etc/resolv.conf
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl logs -n kube-system -l k8s-app=kube-dns --all-containers
```

Common causes: coredns pods crashed/pending, custom DNS config overriding cluster DNS, network policy blocking UDP 53, ndots:5 causing excessive lookups.

---

## Load Balancer Not Working

```bash
kubectl get svc -n <ns> -o wide            # EXTERNAL-IP stuck <pending>?
kubectl describe svc <svc> -n <ns>         # Events for LoadBalancer provisioning errors
az network lb list -g MC_<rg>_<cluster>_<region> -o table
az network lb probe list -g MC_<rg>_<cluster>_<region> --lb-name <lb>
az network lb rule list -g MC_<rg>_<cluster>_<region> --lb-name <lb>
az network nsg rule list -g MC_<rg>_<cluster>_<region> --nsg-name <nsg>
```

Common causes: NSG blocking inbound, health probe path/port mismatch, subnet has no available IPs, service annotation misconfigured.

---

## Storage / PVC Stuck

```bash
kubectl get pvc -n <ns>                    # Status: Pending?
kubectl describe pvc <pvc> -n <ns>         # Events for provisioning error
kubectl get sc                             # StorageClass exists and is default?
kubectl get pv                             # Volume available/bound?
az disk list -g MC_<rg>_<cluster>_<region> --query "[?managedBy=='']" -o table  # Orphaned disks
```

Common causes: wrong StorageClass, disk in wrong zone/region, kubelet identity lacks disk attach permissions, Azure Disk max attach limit per VM size reached.

---

## Managed Identity / Permission Denied

```bash
az aks show -g <rg> -n <cluster> --query "identity"
az aks show -g <rg> -n <cluster> --query "identityProfile"
az role assignment list --assignee <identity-client-id> -o table
az role assignment list --assignee <kubelet-client-id> -o table
# Check if workload identity is configured
kubectl get sa <sa> -n <ns> -o yaml | grep azure.workload.identity
```

Common causes: kubelet identity missing role, federated credential subject mismatch (namespace:sa typo), token audience wrong, identity not in same tenant.

---

## Node Pool Scaling Failure

```bash
az aks nodepool list -g <rg> --cluster-name <cluster> -o table
az aks nodepool show -g <rg> --cluster-name <cluster> -n <pool> --query provisioningState
az monitor activity-log list -g <rg> --offset 1h --query "[?status.value=='Failed']"
az vm list-usage -l <region> -o table | grep -i "Total Regional vCPUs\|Standard.*Family"
```

Common causes: vCPU quota exhaustion, subnet IP exhaustion, VM SKU not available in region, system pool min-count prevents scale-down.

---

## API Server Unreachable / kubectl Can't Connect

```bash
az aks show -g <rg> -n <cluster> --query '{fqdn:fqdn, privateFqdn:privateFqdn, provisioningState:provisioningState, powerState:powerState.code}'
FQDN=$(az aks show -g <rg> -n <cluster> --query fqdn -o tsv)
nslookup "$FQDN"                           # DNS resolution of API server
curl -k -Iv "https://$FQDN"               # TCP + TLS connectivity
kubectl version --client                    # kubectl version (must be within ±2 minor versions of cluster)
az aks show -g <rg> -n <cluster> --query kubernetesVersion -o tsv
az aks show -g <rg> -n <cluster> --query "apiServerAccessProfile" # Authorized IP ranges / private cluster
```

Common causes: cluster stopped (power state not Running), private cluster accessed from outside VNet, client IP not in authorized IP ranges, API server FQDN DNS changed after stop/start, kubectl version skew > 2 minor versions, expired kubeconfig (`az aks get-credentials` to refresh).

---

## Cluster Create / Start Failure (VM Extension Errors)

```bash
az aks show -g <rg> -n <cluster> --query provisioningState -o tsv
az monitor activity-log list -g <rg> --offset 1h --query "[?status.value=='Failed']" -o table
# Check egress connectivity from node's perspective
az aks show -g <rg> -n <cluster> --query "networkProfile.outboundType" -o tsv
az network nsg list -g MC_<rg>_<cluster>_<region> -o table
az network nsg rule list -g MC_<rg>_<cluster>_<region> --nsg-name <nsg> -o table
```

Common causes:
- **Error 50 (OutboundConnFailVMExtensionError):** Node can't reach required endpoints. NSG or firewall blocks outbound to MCR, management.azure.com, or packages.microsoft.com.
- **Error 51 (K8SAPIServerConnFailVMExtensionError):** Node can't connect to API server. Check NSG allows TCP 443 to API server IP.
- **Error 52 (K8SAPIServerDNSLookupFailVMExtensionError):** DNS resolution for API server FQDN fails from node. Custom DNS without proper forwarding.

---

## Upgrade Stuck / Slow

```bash
az aks show -g <rg> -n <cluster> --query '{provisioningState:provisioningState, kubernetesVersion:kubernetesVersion}'
az aks nodepool list -g <rg> --cluster-name <cluster> --query '[].{name:name, provisioningState:provisioningState, orchestratorVersion:orchestratorVersion, upgradeSettings:upgradeSettings}' -o table
kubectl get pdb -A                         # PDBs blocking drain?
kubectl get nodes -o wide                  # Nodes in mixed versions?
az monitor activity-log list -g <rg> --offset 2h --query "[?contains(operationName.value,'Microsoft.ContainerService')]" -o table
```

Common causes: PDB blocking pod eviction (especially system pods), max-surge set to 1 (default — slow for large clusters), node with pods that have `terminationGracePeriodSeconds` > 30m, insufficient subnet IPs to surge new nodes.

---

## Egress / SNAT Exhaustion (Intermittent Outbound Failures)

```bash
az aks show -g <rg> -n <cluster> --query "networkProfile.outboundType" -o tsv
az network lb show -g MC_<rg>_<cluster>_<region> --name kubernetes -o json --query '{outboundRules:outboundRules, frontendIPConfigurations:frontendIPConfigurations | length(@)}'
az network nat gateway list -g MC_<rg>_<cluster>_<region> -o table
kubectl get nodes | wc -l                  # Node count — SNAT issues start at ~500+ nodes
# Test egress from inside a pod
kubectl exec <pod> -n <ns> -- curl -sf -o /dev/null -w "%{http_code}" https://mcr.microsoft.com
```

Common causes: Azure LB SNAT port exhaustion (64K ports shared across nodes), too few frontend IPs for outbound rules, no NAT Gateway configured for large clusters. Fix: switch to `managedNATGateway` outbound type or add frontend IPs to LB.

---

## Certificate Expiration / Rotation

```bash
az aks show -g <rg> -n <cluster> --query "certificateProfile" 2>/dev/null || echo "(check cluster version)"
# Check API server certificate expiry
FQDN=$(az aks show -g <rg> -n <cluster> --query fqdn -o tsv)
echo | openssl s_client -connect "$FQDN:443" -servername "$FQDN" 2>/dev/null | openssl x509 -noout -dates
# Check for pending CSRs (kubelet cert rotation)
kubectl get csr --sort-by='.metadata.creationTimestamp'
# Check node kubelet certificate
kubectl get nodes -o json | jq '.items[] | {name: .metadata.name, kubeletReady: (.status.conditions[] | select(.type=="Ready") | .status)}'
```

Common causes: AKS auto-rotates certs but rotation can fail if cluster is stopped for > 30 days, API server cert expired (nodes go NotReady), kubelet client cert expired (CSR stuck in Pending). Fix: `az aks rotate-certs` for full rotation.
