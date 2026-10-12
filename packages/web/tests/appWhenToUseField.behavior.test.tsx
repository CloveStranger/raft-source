import { useState } from "react";
import { cleanup,fireEvent,render,screen } from "@testing-library/react";
import { AppWhenToUseField } from "../src/components/settings/AppWhenToUseField";
import { TestIntlProvider } from "./helpers/intl";
import { isAppWhenToUseTooLong } from "@botiverse/raft-shared";
afterEach(cleanup);
function Field({initial=""}:{initial?:string}){const [value,setValue]=useState(initial);return <AppWhenToUseField value={value} onChange={e=>setValue(e.target.value)}/>;}
test("visible counter accepts 160 Unicode code points, exposes 161 without truncation and clears the error",()=>{
 render(<TestIntlProvider><Field/></TestIntlProvider>);
 const input=screen.getByRole('textbox') as HTMLInputElement;
 expect(screen.getByText('0 / 160 characters')).toBeTruthy();expect(input.hasAttribute('maxlength')).toBe(false);
 fireEvent.change(input,{target:{value:'😀'.repeat(160)}});
 expect(screen.getByText('160 / 160 characters')).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();expect(isAppWhenToUseTooLong(input.value)).toBe(false);
 fireEvent.change(input,{target:{value:'😀'.repeat(161)}});
 expect(input.value).toBe('😀'.repeat(161));expect(input.getAttribute('aria-invalid')).toBe('true');expect(screen.getByRole('alert').textContent).toContain('160');expect(isAppWhenToUseTooLong(input.value)).toBe(true);
 fireEvent.change(input,{target:{value:'  useful hint  '}});
 expect(screen.getByText('11 / 160 characters')).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();expect(input.getAttribute('aria-invalid')).not.toBe('true');
});
test("existing overlong value is visibly invalid in Chinese before editing",()=>{
 render(<TestIntlProvider locale="zh-cn"><Field initial={'字'.repeat(161)}/></TestIntlProvider>);
 expect(screen.getByText('161 / 160 字')).toBeTruthy();expect(screen.getByRole('alert').textContent).toContain('请缩短至 160 字以内再保存');
});
