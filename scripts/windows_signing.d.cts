// Types for windows_signing.cjs.
declare function sign(configuration: { path: string }): Promise<void>;
declare namespace sign {
	function signFile(path: string): void;
	function enabled(): boolean;
}
export = sign;
