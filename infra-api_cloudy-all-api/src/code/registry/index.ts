import { SERVICE_DEFINITIONS } from "./definitions.js";
import type { ServiceDefinition } from "./types.js";
import { rawHttpRequest } from "../shared/http.js";

export class ServiceRegistry {
  private services: Map<string, ServiceDefinition>;

  constructor() {
    this.services = new Map();
    for (const svc of SERVICE_DEFINITIONS) {
      this.services.set(svc.name, svc);
    }
  }

  list(): ServiceDefinition[] {
    return Array.from(this.services.values());
  }

  get(name: string): ServiceDefinition | undefined {
    return this.services.get(name);
  }

  getBaseUrl(name: string): string | null {
    const svc = this.services.get(name);
    if (!svc) return null;
    return `http://${svc.wgIp}:${svc.port}`;
  }

  async fetchSpec(name: string): Promise<unknown | null> {
    const svc = this.services.get(name);
    if (!svc?.api?.specUrl) return null;

    const result = rawHttpRequest("GET", svc.api.specUrl, undefined, 10_000);
    if (result.ok) return result.data;
    return null;
  }
}

// Singleton
export const registry = new ServiceRegistry();
