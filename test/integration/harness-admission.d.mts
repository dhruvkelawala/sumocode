/** Hold a trusted bootstrap until the parent has registered its birth. */
export declare function prepareHarnessAdmission(command: string, args: readonly string[], evidenceDir: string): {
    command: string;
    args: string[];
    release(pid: number): void;
    cancel(): void;
};
