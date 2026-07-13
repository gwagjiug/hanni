import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

const sourceTypeAssertionRule = {
  selector:
    "TSAsExpression:not([typeAnnotation.type='TSTypeReference'][typeAnnotation.typeName.name='const'])",
  message: '외부 값은 타입 단언 대신 parser 또는 type guard로 검증합니다.',
};

export default tseslint.config(
  {
    ignores: ['coverage/**', 'dist/**', 'node_modules/**', '_workspace/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts'],
    plugins: { import: importPlugin },
    rules: {
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'import/no-duplicates': 'error',
      'no-implicit-coercion': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', sourceTypeAssertionRule],
    },
  },
);
