import { describe, expect, it } from 'vitest';
import { payloadHints, payloadKeys, payloadText } from '../src/shared/payload';
import { buildWorkspace } from '../src/shared/workspace';
import { parseDocument } from '../src/shared/xml';

function workspace(xml: string) {
  return buildWorkspace([{ path: 'a.xml', ...parseDocument(`<root BTCPP_format="4">${xml}</root>`) }]);
}

describe('payloadKeys', () => {
  it('finds the global entries of ports, scripts and included trees, once each', () => {
    const ws = workspace(`
      <BehaviorTree ID="Main" _description="Mail me@example.com">
        <Sequence _skipIf="@skip == true">
          <Script code="count := @start + 1"/>
          <MoveTo goal="{@target}" speed="{local}" name="to {@not_a_port}"/>
          <SubTree ID="Inner" goal="{@target}"/>
        </Sequence>
      </BehaviorTree>
      <BehaviorTree ID="Inner">
        <Sequence>
          <MoveTo goal="{goal}" speed="{@speed}"/>
          <SubTree ID="Main"/>
        </Sequence>
      </BehaviorTree>`);
    expect(payloadKeys(ws, 'Main')).toEqual(['skip', 'start', 'target', 'speed']);
  });

  it('returns nothing for a missing tree', () => {
    expect(payloadKeys(workspace(''), 'Nope')).toEqual([]);
  });
});

describe('payloadText', () => {
  it('writes a YAML map of the entries that have a value', () => {
    expect(payloadText({ joints: ' [joint1, joint2] ', duration: '3.0', offset: '' }))
      .toBe('joints: [joint1, joint2]\nduration: 3.0');
  });
});

describe('payloadHints', () => {
  const ws = workspace(`
    <BehaviorTree ID="Move">
      <Sequence>
        <Read joints="{@joints}"/>
        <Go joints="{@joints}" offset="{@offset}" limit="{@limit}" note="{@note}"/>
      </Sequence>
    </BehaviorTree>
    <TreeNodesModel>
      <Action ID="Read"><input_port name="joints">joints to read, e.g. [a, b]</input_port></Action>
      <Action ID="Go"><input_port name="offset">a number, e.g. 1.0</input_port></Action>
      <SubTree ID="Move">
        <input_port name="joints">the joints to move, e.g. joint1 or [joint1, joint2]</input_port>
        <input_port name="offset">how far, in radians, e.g. -6.28 or [-6.28, 6.28]</input_port>
        <input_port name="limit">top speed, in rad/s</input_port>
        <input_port name="note"/>
      </SubTree>
    </TreeNodesModel>`);
  const hints = payloadHints(ws, 'Move');

  it('takes the example from the end of the description of the tree\'s own port', () => {
    expect(hints.get('joints')).toEqual({ description: 'the joints to move', example: 'joint1 or [joint1, joint2]' });
    expect(hints.get('offset')).toEqual({ description: 'how far, in radians', example: '-6.28 or [-6.28, 6.28]' });
  });

  it('gives the description of a port without an example', () => {
    expect(hints.get('limit')).toEqual({ description: 'top speed, in rad/s' });
  });

  it('gives nothing for a port without a description, nor for a tree without a model', () => {
    expect(hints.has('note')).toBe(false);
    expect(payloadHints(workspace('<BehaviorTree ID="Bare"><Read joints="{@joints}"/></BehaviorTree>'), 'Bare').size).toBe(0);
  });
});
