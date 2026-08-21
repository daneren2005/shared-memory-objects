import { defineConfig } from 'oxlint';

export default defineConfig({
	plugins: [
		'typescript',
		'unicorn',
		'oxc',
		'import',
		'promise',
		'vitest',
	],
	jsPlugins: [
		// NOTE: This adds 2-3 seconds so would be good to see if we can switch to oxfmt and remove the need for eslint-plugin-stylistic
		'@stylistic/eslint-plugin',
	],
	categories: {
		correctness: 'error',
		suspicious: 'error',
	},
	rules: {
		'no-console': process.env.NODE_ENV === 'production' ? ['error', { allow: ['warn', 'error'] }] : 'off',
		'no-debugger': process.env.NODE_ENV === 'production' ? 'error' : 'off',
		'no-empty': process.env.NODE_ENV === 'production' ? 'error' : 'off',
		'no-constant-condition': process.env.NODE_ENV === 'production' ? 'error' : 'off',
		'no-unreachable': process.env.NODE_ENV === 'production' ? 'error' : 'off',
		'no-case-declarations': 'off',
		'prefer-const': 'off',
		'no-unused-vars': ['error', { args: 'none' }],
		'no-use-before-define': ['error', { functions: false, classes: false, variables: true }],
		'import/default': 'off',
		'require-post-message-target-origin': 'off',
		'no-extraneous-class': 'off',
		'no-unassigned-import': 'off',
		'prefer-add-event-listener': 'off',
		'no-underscore-dangle': 'off',

		// Promises
		'require-await': 'error',
		'promise/no-multiple-resolved': 'off',
		'typescript/no-misused-promises': 'error',
		'promise/always-return': ['error', { ignoreLastCallback: true }],

		// Typescript
		'typescript/ban-ts-comment': 'off',
		'typescript/no-explicit-any': 'off',
		'typescript/no-unsafe-type-assertion': 'off',
		'typescript/no-misused-spread': 'off',
		'typescript/unbound-method': 'off',
		'typescript/no-unnecessary-boolean-literal-compare': 'off',
		'typescript/consistent-type-imports': 'error',
		'typescript/no-unnecessary-type-parameters': 'off',
		// This library persists enum discriminants (data types) as raw numbers inside shared memory and reads
		// them back as `number`, so switching a numeric read against enum members is the intended, safe pattern.
		// Casting the discriminant to satisfy this rule only trips no-unnecessary-type-assertion, so leave it off.
		'typescript/no-unsafe-enum-comparison': 'off',

		// Stylistic
		'@stylistic/arrow-parens': 'off',
		'@stylistic/brace-style': ['error', '1tbs'],
		'@stylistic/comma-dangle': ['error', 'always-multiline'],
		'@stylistic/eol-last': 'off',
		'@stylistic/indent': ['error', 'tab', {
			SwitchCase: 1,
			ignoredNodes: ['TemplateLiteral'],
		}],
		'@stylistic/indent-binary-ops': ['error', 'tab'],
		'@stylistic/keyword-spacing': ['error', {
			overrides: {
				catch: { after: false },
				for: { after: false },
				if: { after: false },
				switch: { after: false },
				while: { after: false },
			},
		}],
		'@stylistic/lines-between-class-members': 'off',
		'@stylistic/max-len': ['error', { code: 200 }],
		'@stylistic/member-delimiter-style': ['error', {
			multiline: {
				delimiter: 'none',
			},
			singleline: {
				delimiter: 'comma',
			},
		}],
		'@stylistic/no-multiple-empty-lines': 'off',
		'@stylistic/no-tabs': 'off',
		'@stylistic/no-trailing-spaces': ['error', { skipBlankLines: true }],
		'@stylistic/quotes': [2, 'single', {
			avoidEscape: true,
		}],
		'@stylistic/semi': [2, 'always'],
		'@stylistic/space-before-function-paren': 'off',
		'@stylistic/spaced-comment': 'off',

		// Test rules
		'vitest/no-conditional-expect': 'off',
		'vitest/no-conditional-tests': 'off',
		'vitest/expect-expect': process.env.NODE_ENV === 'production' ? 'error' : 'off',
		'no-focused-tests': process.env.NODE_ENV === 'production' ? 'error' : 'off',
		'no-array-sort': 'off',
		'vitest/no-disabled-tests': 'off',
		'vitest/warn-todo': 'off',
	},
	env: {
		builtin: true,
	},
	globals: {
		process: 'readonly',
	},
	ignorePatterns: [
		'.cache',
	],
	options: {
		// Adds 3-4 seconds to lint time
		typeAware: true,
	},
});
