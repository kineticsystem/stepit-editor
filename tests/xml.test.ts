import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isBehaviorFile, newDocument, parseDocument, serializeDocument, trees } from '../src/shared/xml';

const EXAMPLES = join(__dirname, '../behaviors');

describe('parseDocument', () => {
  it('reads the compact and the explicit forms', () => {
    const { doc } = parseDocument(`<root BTCPP_format="4">
      <BehaviorTree ID="T">
        <Sequence>
          <Action ID="MoveTo" goal="{g}"/>
          <SaySomething message="hi"/>
          <SubTree ID="Other" x="{y}"/>
        </Sequence>
      </BehaviorTree>
    </root>`);
    const [seq] = trees(doc!)[0].children;
    expect(seq.id).toBe('Sequence');
    expect(seq.children.map((n) => [n.id, n.tag])).toEqual([
      ['MoveTo', 'Action'], ['SaySomething', 'SaySomething'], ['SubTree', 'SubTree'],
    ]);
    expect(seq.children[0].attrs).toEqual({ goal: '{g}' });
    expect(seq.children[2].attrs).toEqual({ ID: 'Other', x: '{y}' });
  });

  it('reports syntax errors with their line', () => {
    const { error } = parseDocument('<root>\n<BehaviorTree ID="T">\n</root>');
    expect(error?.message).toMatch(/syntax error/);
    expect(error?.line).toBe(2); // The line of the unclosed element.
  });

  it('refuses a document that is not a <root>', () => {
    expect(parseDocument('<BehaviorTree ID="T"/>').error?.message).toMatch(/must be <root>/);
  });
});

describe('serializeDocument', () => {
  it.each(readdirSync(EXAMPLES).filter((f) => f.endsWith('.xml')))('round-trips %s unchanged', (file) => {
    const text = readFileSync(join(EXAMPLES, file), 'utf8');
    expect(serializeDocument(parseDocument(text).doc!)).toBe(text);
  });

  it('keeps comments, unknown elements and escapes attributes', () => {
    const text = `<?xml version="1.0" encoding="UTF-8"?>
<root BTCPP_format="4">
  <include path="other.xml"/>

  <!-- A tree -->
  <BehaviorTree ID="T">
    <Sequence>
      <!-- first -->
      <Script code="a := b &amp;&amp; c &lt; 3"/>
      <!-- trailing -->
    </Sequence>
  </BehaviorTree>
</root>
`;
    const out = serializeDocument(parseDocument(text).doc!);
    expect(out).toBe(text);
  });

  it('keeps the comments around <root>', () => {
    const text = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Objective: MoveJointsTo
-->
<root BTCPP_format="4">
  <BehaviorTree ID="T">
    <AlwaysSuccess/>
  </BehaviorTree>
</root>
<!-- The end -->
`;
    expect(serializeDocument(parseDocument(text).doc!)).toBe(text);
  });

  it('writes a new document that parses back', () => {
    const out = serializeDocument(newDocument('Fresh'));
    expect(out).toContain('<root BTCPP_format="4" main_tree_to_execute="Fresh">');
    const [tree] = trees(parseDocument(out).doc!);
    expect(tree.id).toBe('Fresh');
    expect(tree.children.map((n) => n.id)).toEqual(['Sequence']);
  });

  it('writes a new subtree without a main tree', () => {
    const out = serializeDocument(newDocument('Helper', false));
    expect(out).toContain('<root BTCPP_format="4">');
    expect(out).not.toContain('main_tree_to_execute');
    expect(trees(parseDocument(out).doc!)[0].id).toBe('Helper');
  });
});

describe('isBehaviorFile', () => {
  it('tells behaviors from other XML files', () => {
    expect(isBehaviorFile('<?xml version="1.0"?>\n<!-- <package> -->\n<root BTCPP_format="4"/>')).toBe(true);
    expect(isBehaviorFile('<?xml version="1.0"?>\n<?xml-model href="x"?>\n<package format="3"/>')).toBe(false);
    expect(isBehaviorFile('not xml at all')).toBe(true);
  });
});
