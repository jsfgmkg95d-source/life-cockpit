export {};

declare global {
  interface Window {
    lifeCockpitDesktop?: {
      openWidget(): Promise<void>;
      openMain(): Promise<void>;
      hideWidget(): Promise<void>;
      setWidgetAlwaysOnTop(value: boolean): Promise<{ alwaysOnTop: boolean }>;
      getWidgetState(): Promise<{ alwaysOnTop: boolean }>;
    };
  }
}
