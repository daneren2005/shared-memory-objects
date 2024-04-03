/* eslint-env node */
require('@rushstack/eslint-patch/modern-module-resolution');

module.exports = {
	root: true,
	extends: [
		'eslint:recommended',
		'plugin:vitest/recommended',
		'plugin:@typescript-eslint/recommended'
	],
	parserOptions: {
		ecmaVersion: 'latest'
	},
	rules: {
		'@typescript-eslint/ban-ts-comment': 'off',
		'@typescript-eslint/no-explicit-any': 'off',
		'@typescript-eslint/no-unused-vars': ['error', { 'args': 'none' }],
		'comma-dangle': ['error', 'never'],
		'indent': ['error', 'tab', { 'SwitchCase': 1 }],
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
		'quotes': [2, 'single', { avoidEscape: true }],

		'vitest/no-focused-tests': 'error',
		// Vitest throws this error for every benchmark
		'vitest/expect-expect': 'off'
	}
};
