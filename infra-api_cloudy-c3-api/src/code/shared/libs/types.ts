export interface VmConfig {
  ip: string;
  wg_ip?: string;
  user: string;
  method: "key" | "gcloud";
  ssh_alias?: string;
  gcloud_instance?: string;
  gcloud_zone?: string;
  description: string;
  containers?: string[];
}

export interface ServiceConfig {
  category: "app" | "mic" | "sec" | "tools" | "cloud" | "data" | "fin" | "agi";
  vm: string;
  flake?: string;
  subfolder?: string;
  folder?: string;
  description: string;
  discovered?: boolean;
  containers?: string[];
  domain?: string;
  ports?: string[];
}

export interface InfraConfig {
  ssh_key: string;
  remote_base: string;
  vms: Record<string, VmConfig>;
  services: Record<string, ServiceConfig>;
}
