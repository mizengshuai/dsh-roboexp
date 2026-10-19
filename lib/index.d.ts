import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "dsh-roboexp";
export declare const inject: string[];
export interface Config {
    roboDir: string;
    softwareType: string;
    modulesDir: string;
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config: Config): void;
