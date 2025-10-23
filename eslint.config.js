import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import vitest from '@vitest/eslint-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
	baseDirectory: __dirname,
	recommendedConfig: js.configs.recommended,
	allConfig: js.configs.all
});

export default defineConfig([globalIgnores(['./dist']), {
	extends: compat.extends(
		'eslint:recommended',
		'plugin:@typescript-eslint/recommended'
	),
	plugins: {
		vitest
	},

	languageOptions: {
		ecmaVersion: 'latest',
		parserOptions: {}
	},

	rules: {
		...vitest.configs.recommended.rules,
		'@typescript-eslint/ban-ts-comment': 'off',
		'@typescript-eslint/no-explicit-any': 'off',

		'@typescript-eslint/no-unused-vars': ['error', {
			'args': 'none'
		}],

		'comma-dangle': ['error', 'never'],

		'indent': ['error', 'tab', {
			'SwitchCase': 1
		}],

		'keyword-spacing': ['error', {
			'overrides': {
				if: {
					after: false
				},

				for: {
					after: false
				},

				while: {
					after: false
				},

				catch: {
					after: false
				},

				switch: {
					after: false
				},

				await: {
					after: false
				}
			}
		}],

		'prefer-const': 'off',
		'semi': [2, 'always'],

		'quotes': [2, 'single', {
			avoidEscape: true
		}],

		'vitest/no-focused-tests': 'error',
		'vitest/expect-expect': 'off'
	}
}]);
