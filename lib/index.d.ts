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
type PresetParam = {
    name: string;
    type: string;
    default: string;
    min: string;
    max: string;
    desc: string;
};
interface Preset {
    id: string;
    name: string;
    caption: string;
    description: string;
    icon: string;
    params: PresetParam[];
    code: string;
}
export declare const PRESETS: Preset[];
export declare function apply(ctx: Context, config: Config): void;
export {};
