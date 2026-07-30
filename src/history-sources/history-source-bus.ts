import type {
  HistorySourceAdapter,
  HistorySourceContext,
  HistorySourceDescriptor,
  HistorySourceProbe,
  HistorySourceSnapshot,
  HistorySourceVersion
} from "./types";

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedProbe(
  descriptor: HistorySourceDescriptor,
  error: unknown
): HistorySourceProbe {
  return {
    descriptor,
    available: false,
    status: "error",
    summary: "读取失败，其他历史来源仍可继续使用。",
    versions: [],
    error: errorText(error)
  };
}

function normalizedVersions(
  descriptor: HistorySourceDescriptor,
  versions: readonly HistorySourceVersion[]
): HistorySourceVersion[] {
  const seen = new Set<string>();
  const result: HistorySourceVersion[] = [];
  for (const version of versions) {
    const id = `${descriptor.kind}:${version.id}`;
    if (
      version.source !== descriptor.kind
      || !version.id
      || seen.has(id)
      || Number.isNaN(new Date(version.capturedAt).getTime())
    ) continue;
    seen.add(id);
    result.push({ ...version, id });
  }
  return result;
}

function versionTime(version: HistorySourceVersion): number {
  const value = new Date(version.capturedAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

export class HistorySourceBus {
  private readonly adapters: readonly HistorySourceAdapter[];

  constructor(adapters: readonly HistorySourceAdapter[]) {
    const kinds = new Set<string>();
    for (const adapter of adapters) {
      if (kinds.has(adapter.descriptor.kind)) {
        throw new Error(`Duplicate history source adapter: ${adapter.descriptor.kind}`);
      }
      kinds.add(adapter.descriptor.kind);
    }
    this.adapters = [...adapters];
  }

  descriptors(): HistorySourceDescriptor[] {
    return this.adapters.map((adapter) => ({
      ...adapter.descriptor,
      capabilities: { ...adapter.descriptor.capabilities }
    }));
  }

  async inspect(
    context: HistorySourceContext,
    signal?: AbortSignal
  ): Promise<HistorySourceSnapshot> {
    aborted(signal);
    const probes = await Promise.all(this.adapters.map(async (adapter) => {
      try {
        const probe = await adapter.probe(context, signal);
        aborted(signal);
        return {
          ...probe,
          descriptor: adapter.descriptor,
          versions: normalizedVersions(adapter.descriptor, probe.versions)
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        return failedProbe(adapter.descriptor, error);
      }
    }));
    aborted(signal);
    const versions = probes
      .flatMap((probe) => probe.versions)
      .sort((left, right) => {
        const time = versionTime(right) - versionTime(left);
        if (time !== 0) return time;
        const source = left.source.localeCompare(right.source);
        return source !== 0 ? source : left.id.localeCompare(right.id);
      });
    return {
      filePath: context.filePath,
      capturedAt: new Date().toISOString(),
      probes,
      versions
    };
  }
}

export function providerHandoffProbe(
  descriptor: HistorySourceDescriptor,
  available: boolean,
  summary: string
): HistorySourceProbe {
  return {
    descriptor,
    available,
    status: available ? "handoff" : "unavailable",
    summary,
    versions: []
  };
}
